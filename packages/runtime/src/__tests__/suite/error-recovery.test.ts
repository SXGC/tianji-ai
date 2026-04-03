/**
 * 错误恢复与降级集成测试。
 *
 * 业务职责：
 * - 验证工具执行异常后 runtime 正确进入 failed 状态并产生 tool.failed 事件。
 * - 验证 run 失败后同一 session 可继续发起新 runTurn 并恢复。
 * - 验证 cancelRun 触发 run.cancelled，并按工具 sideEffect 等级正确设置
 *   pendingOperations.status 与 resumeHint。
 *
 * 对外触点：
 * - 通过 createSessionRuntime + fakeModel 构建确定性 LLM 替身。
 * - 依赖 helpers/runtime-test-utils 完成事件断言与工具注册。
 */
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { DEFAULT_EXECUTION_POLICY, createSessionId } from '@tianji/shared'

import { createSessionRuntime } from '../../runtime.js'
import { InMemorySnapshotStore } from '../../snapshot-store.js'
import { ToolRegistry } from '../../tool-catalog.js'
import {
  assertRunCompleted,
  assertToolFailed,
  collectRuntimeEvents,
  collectRuntimeOutcome,
  createAbortError,
  createDeferred,
  createMockTool,
  createToolRegistry,
  createUserMessage,
  waitForRunStatus,
} from '../helpers/runtime-test-utils.js'

describe('suite/error-recovery', () => {
  it('工具 execute 抛异常 → run.failed', async () => {
    const explodeTool = createMockTool('explode', { error: new Error('boom') })
    const toolRegistry = createToolRegistry(explodeTool)
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([{ name: 'explode', args: {}, id: 'tool-explode' }]),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: toolRegistry,
    })

    const sessionId = createSessionId('err-tool-throw')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-explode', 'explode'),
    })
    const outcome = await collectRuntimeOutcome(runId, runtime)

    expect(outcome.error).toBeDefined()
    assertToolFailed(outcome.events, 'explode')

    const snapshot = await waitForRunStatus(runtime, runId, 'failed')
    expect(snapshot.metadata?.failureCode).toBeDefined()
  })

  it('run 失败后同 session 可发起新 runTurn', async () => {
    const snapshotStore = new InMemorySnapshotStore()

    // 第一轮：失败
    const failTool = createMockTool('fail-tool', { error: new Error('first-run-error') })
    const failRegistry = createToolRegistry(failTool)
    const failRuntime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([{ name: 'fail-tool', args: {}, id: 'tool-fail-1' }]),
      },
      snapshotStore,
      toolCatalog: failRegistry,
    })

    const sessionId = createSessionId('err-recover-session')
    await failRuntime.createSession({ sessionId })

    const failRunId = await failRuntime.runTurn({
      sessionId,
      message: createUserMessage('msg-fail', 'do something'),
    })
    const failOutcome = await collectRuntimeOutcome(failRunId, failRuntime)
    expect(failOutcome.error).toBeDefined()
    await waitForRunStatus(failRuntime, failRunId, 'failed')

    // 第二轮：成功（共享 snapshotStore）
    const successRuntime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage('recovered')),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const successRunId = await successRuntime.runTurn({
      sessionId,
      message: createUserMessage('msg-recover', 'recover'),
    })
    const successEvents = await collectRuntimeEvents(successRunId, successRuntime)

    assertRunCompleted(successEvents)
  })

  it('cancelRun 触发 run.cancelled', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const toolCatalog = new ToolRegistry().registerTool({
      spec: { name: 'slow', description: 'Slow', parameters: { type: 'object' } },
      execute: async (_args, context) => {
        toolSignalSeen.resolve(context.abortSignal)
        await new Promise<never>((_resolve, reject) => {
          context.abortSignal?.addEventListener(
            'abort',
            () => {
              reject(createAbortError('cancelled'))
            },
            { once: true }
          )
        })
        throw new Error('Unreachable')
      },
      sideEffect: 'idempotent',
    })

    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([{ name: 'slow', args: {}, id: 'tc-slow-cancel' }]),
      },
      snapshotStore,
      toolCatalog,
    })

    const sessionId = createSessionId('err-cancel-basic')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-cancel', 'do slow'),
    })
    const eventsPromise = collectRuntimeOutcome(runId, runtime)
    await toolSignalSeen.promise

    runtime.cancelRun(runId)

    const outcome = await eventsPromise
    const eventTypes = outcome.events.map((e) => e.type)
    expect(eventTypes).toContain('run.cancelled')
  })

  it('取消时 destructive 工具 → aborted-with-side-effect + require-user-confirmation', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const toolCatalog = new ToolRegistry().registerTool({
      spec: { name: 'danger', description: 'Dangerous', parameters: { type: 'object' } },
      execute: async (_args, context) => {
        toolSignalSeen.resolve(context.abortSignal)
        await new Promise<never>((_resolve, reject) => {
          context.abortSignal?.addEventListener(
            'abort',
            () => {
              reject(createAbortError('cancelled'))
            },
            { once: true }
          )
        })
        throw new Error('Unreachable')
      },
      sideEffect: 'destructive',
    })

    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([{ name: 'danger', args: {}, id: 'tc-danger-cancel' }]),
      },
      snapshotStore,
      toolCatalog,
    })

    const sessionId = createSessionId('err-cancel-destructive')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-cancel-destructive', 'danger'),
      policy: {
        ...DEFAULT_EXECUTION_POLICY,
        tool: { ...DEFAULT_EXECUTION_POLICY.tool, allowDestructive: true },
      },
    })
    const eventsPromise = collectRuntimeOutcome(runId, runtime)
    await toolSignalSeen.promise

    runtime.cancelRun(runId)

    await eventsPromise
    const cancelledRun = await waitForRunStatus(runtime, runId, 'cancelled')

    expect(cancelledRun.pendingOperations.length).toBeGreaterThan(0)
    expect(cancelledRun.pendingOperations[0]!.status).toBe('aborted-with-side-effect')
    expect(cancelledRun.resumeHint).toBe('require-user-confirmation')
  })

  it('取消时 none 工具 → aborted-clean + replay', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const toolCatalog = new ToolRegistry().registerTool({
      spec: { name: 'pure', description: 'Pure', parameters: { type: 'object' } },
      execute: async (_args, context) => {
        toolSignalSeen.resolve(context.abortSignal)
        await new Promise<never>((_resolve, reject) => {
          context.abortSignal?.addEventListener(
            'abort',
            () => {
              reject(createAbortError('cancelled'))
            },
            { once: true }
          )
        })
        throw new Error('Unreachable')
      },
      sideEffect: 'none',
    })

    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([{ name: 'pure', args: {}, id: 'tc-pure-cancel' }]),
      },
      snapshotStore,
      toolCatalog,
    })

    const sessionId = createSessionId('err-cancel-none')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-cancel-none', 'pure'),
    })
    const eventsPromise = collectRuntimeOutcome(runId, runtime)
    await toolSignalSeen.promise

    runtime.cancelRun(runId)

    await eventsPromise
    const cancelledRun = await waitForRunStatus(runtime, runId, 'cancelled')

    expect(cancelledRun.pendingOperations.length).toBeGreaterThan(0)
    expect(cancelledRun.pendingOperations[0]!.status).toBe('aborted-clean')
    expect(cancelledRun.resumeHint).toBe('replay')
  })

  it('取消时 idempotent 工具 → aborted-clean + replay', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const toolCatalog = new ToolRegistry().registerTool({
      spec: { name: 'idem', description: 'Idempotent', parameters: { type: 'object' } },
      execute: async (_args, context) => {
        toolSignalSeen.resolve(context.abortSignal)
        await new Promise<never>((_resolve, reject) => {
          context.abortSignal?.addEventListener(
            'abort',
            () => {
              reject(createAbortError('cancelled'))
            },
            { once: true }
          )
        })
        throw new Error('Unreachable')
      },
      sideEffect: 'idempotent',
    })

    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([{ name: 'idem', args: {}, id: 'tc-idem-cancel' }]),
      },
      snapshotStore,
      toolCatalog,
    })

    const sessionId = createSessionId('err-cancel-idempotent')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-cancel-idem', 'idempotent'),
    })
    const eventsPromise = collectRuntimeOutcome(runId, runtime)
    await toolSignalSeen.promise

    runtime.cancelRun(runId)

    await eventsPromise
    const cancelledRun = await waitForRunStatus(runtime, runId, 'cancelled')

    expect(cancelledRun.pendingOperations.length).toBeGreaterThan(0)
    expect(cancelledRun.pendingOperations[0]!.status).toBe('aborted-clean')
    expect(cancelledRun.resumeHint).toBe('replay')
  })
})
