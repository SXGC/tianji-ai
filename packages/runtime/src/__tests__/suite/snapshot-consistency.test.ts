/**
 * 快照一致性集成测试。
 *
 * 业务职责：
 * - 验证 run completed / cancelled / failed 后的 RunSnapshot 字段正确性。
 * - 验证 SessionSnapshot 在 run 完成后的消息追加与 updatedAt 更新。
 * - 验证 closeSession 的 closedAt 写入、活跃 run 中止、以及 closed session 拒绝后续操作。
 *
 * 对外触点：
 * - 通过 createSessionRuntime + fakeModel 构建确定性 LLM 替身。
 * - 依赖 helpers/runtime-test-utils 完成事件收集、取消模式与状态轮询。
 */
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { createSessionId } from '@tianji/shared'

import { createSessionRuntime } from '../../runtime.js'
import { InMemorySnapshotStore } from '../../snapshot-store.js'
import { ToolRegistry } from '../../tool-catalog.js'
import {
  collectRuntimeEvents,
  collectRuntimeOutcome,
  createAbortError,
  createDeferred,
  createMockTool,
  createToolRegistry,
  createUserMessage,
  waitForRunStatus,
} from '../helpers/runtime-test-utils.js'

describe('suite/snapshot-consistency', () => {
  it('run completed 后 RunSnapshot 正确', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage('hello')),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const sessionId = createSessionId('snap-completed')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-snap-completed', 'hi'),
    })
    await collectRuntimeEvents(runId, runtime)

    const runSnapshot = await runtime.getRunSnapshot(runId)
    expect(runSnapshot).toBeDefined()
    expect(runSnapshot!.status).toBe('completed')
    // messages 至少包含 user + assistant
    expect(runSnapshot!.messages.length).toBeGreaterThanOrEqual(2)
    const hasUser = runSnapshot!.messages.some((m) => m.role === 'user')
    const hasAssistant = runSnapshot!.messages.some((m) => m.role === 'assistant')
    expect(hasUser).toBe(true)
    expect(hasAssistant).toBe(true)
    // pendingOperations 存在且第一个 status 为 completed（无工具时为空数组也可接受）
    expect(runSnapshot!.pendingOperations).toBeDefined()
  })

  it('run cancelled 后 RunSnapshot 正确', async () => {
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

    const sessionId = createSessionId('snap-cancelled')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-snap-cancelled', 'do slow'),
    })
    const eventsPromise = collectRuntimeOutcome(runId, runtime)

    await toolSignalSeen.promise
    runtime.cancelRun(runId)

    await eventsPromise
    const runSnapshot = await waitForRunStatus(runtime, runId, 'cancelled')

    expect(runSnapshot.status).toBe('cancelled')
    expect(runSnapshot.cancelPoint).toBeDefined()
    expect(runSnapshot.pendingOperations).toBeDefined()
    // 当有 idempotent 工具被中断时，pendingOperations 可能有 aborted-clean 项
    if (runSnapshot.pendingOperations.length > 0) {
      expect(runSnapshot.pendingOperations[0]!.status).toBe('aborted-clean')
    }
  })

  it('run failed 后 RunSnapshot 正确', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const failingTool = createMockTool('boom', { error: new Error('kaboom') })
    const toolRegistry = createToolRegistry(failingTool)

    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'boom', args: {}, id: 'tc-boom' }])
          .respond(new AIMessage('done')),
      },
      snapshotStore,
      toolCatalog: toolRegistry,
    })

    const sessionId = createSessionId('snap-failed')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-snap-failed', 'go boom'),
    })
    await collectRuntimeOutcome(runId, runtime)

    const runSnapshot = await runtime.getRunSnapshot(runId)
    expect(runSnapshot).toBeDefined()
    expect(runSnapshot!.status).toBe('failed')
    expect(runSnapshot!.metadata?.failureCode).toBeDefined()
  })

  it('run completed 后 SessionSnapshot 追加 assistant 消息', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage('response-text')),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const sessionId = createSessionId('snap-session-append')
    const session = await runtime.createSession({ sessionId })
    const createdUpdatedAt = session.updatedAt

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-session-append', 'question'),
    })
    await collectRuntimeEvents(runId, runtime)

    const sessionSnapshot = await runtime.getSessionSnapshot(sessionId)
    expect(sessionSnapshot).toBeDefined()
    expect(sessionSnapshot!.messages).toHaveLength(2)
    expect(sessionSnapshot!.messages[0]!.role).toBe('user')
    expect(sessionSnapshot!.messages[1]!.role).toBe('assistant')
    expect(sessionSnapshot!.updatedAt).toBeGreaterThanOrEqual(createdUpdatedAt)
  })

  it('closeSession 写入 closedAt', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage('hi')),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const sessionId = createSessionId('snap-close')
    await runtime.createSession({ sessionId })

    const closedSession = await runtime.closeSession(sessionId)
    expect(closedSession.metadata?.closedAt).toBeDefined()
  })

  it('closeSession 中止活跃 run', async () => {
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
        model: fakeModel().respondWithTools([{ name: 'slow', args: {}, id: 'tc-slow-close' }]),
      },
      snapshotStore,
      toolCatalog,
    })

    const sessionId = createSessionId('snap-close-abort')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-close-abort', 'do slow'),
    })
    const eventsPromise = collectRuntimeOutcome(runId, runtime)

    await toolSignalSeen.promise
    await runtime.closeSession(sessionId)

    await eventsPromise
    const runSnapshot = await waitForRunStatus(runtime, runId, 'cancelled')
    expect(runSnapshot.status).toBe('cancelled')
  })

  it('closed session 拒绝 runTurn', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage('nope')),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const sessionId = createSessionId('snap-closed-run')
    await runtime.createSession({ sessionId })
    await runtime.closeSession(sessionId)

    await expect(
      runtime.runTurn({
        sessionId,
        message: createUserMessage('msg-closed-run', 'hello'),
      })
    ).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })

  it('closed session 拒绝 resumeRun', async () => {
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
        model: fakeModel().respondWithTools([{ name: 'slow', args: {}, id: 'tc-slow-resume' }]),
      },
      snapshotStore,
      toolCatalog,
    })

    const sessionId = createSessionId('snap-closed-resume')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-closed-resume', 'do slow'),
    })
    const eventsPromise = collectRuntimeOutcome(runId, runtime)

    await toolSignalSeen.promise
    runtime.cancelRun(runId)

    await eventsPromise
    await waitForRunStatus(runtime, runId, 'cancelled')

    await runtime.closeSession(sessionId)

    await expect(runtime.resumeRun({ runId })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })
})
