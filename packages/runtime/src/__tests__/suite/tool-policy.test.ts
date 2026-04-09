/**
 * 工具执行策略集成测试。
 *
 * 业务职责：
 * - 验证 runtime 根据 ExecutionPolicy 正确拦截或放行不同 sideEffect 等级的工具调用。
 * - 验证 ensureToolAllowed 的单元行为覆盖所有 sideEffect x allowDestructive 排列。
 * - 验证未注册工具的 TOOL_NOT_FOUND 错误语义。
 *
 * 对外触点：
 * - 通过 createSessionRuntime + fakeModel 构建确定性 LLM 替身。
 * - 依赖 helpers/runtime-test-utils 完成事件断言与工具注册。
 */
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import {
  DEFAULT_EXECUTION_POLICY,
  PolicyError,
  ToolError,
  createRunId,
  createSessionId,
} from '@tianji/shared'

import { InMemorySnapshotStore } from '../../snapshot-store.js'
import { type RuntimeToolDefinition, ToolRegistry, ensureToolAllowed } from '../../tool-catalog.js'
import {
  assertRunCompleted,
  assertToolCalled,
  collectRuntimeOutcome,
  createMockTool,
  createTestRuntime,
  createToolRegistry,
  createUserMessage,
} from '../helpers/runtime-test-utils.js'

describe('suite/tool-policy', () => {
  it('sideEffect=none 工具正常执行', async () => {
    const safeTool = createMockTool('safe', { sideEffect: 'none', result: 'ok' })
    const toolRegistry = createToolRegistry(safeTool)
    const runtime = createTestRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'safe', args: {}, id: 'tc-safe-1' }])
          .respond(new AIMessage('done')),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: toolRegistry,
    })

    const sessionId = createSessionId('policy-none')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-none', 'use safe tool'),
    })
    const outcome = await collectRuntimeOutcome(runId, runtime)

    assertToolCalled(outcome.events, 'safe')
    assertRunCompleted(outcome.events)
    expect(outcome.error).toBeUndefined()
  })

  it('sideEffect=idempotent 工具正常执行', async () => {
    const idempotentTool = createMockTool('idempotent', { sideEffect: 'idempotent', result: 'ok' })
    const toolRegistry = createToolRegistry(idempotentTool)
    const runtime = createTestRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'idempotent', args: {}, id: 'tc-idem-1' }])
          .respond(new AIMessage('done')),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: toolRegistry,
    })

    const sessionId = createSessionId('policy-idempotent')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-idem', 'use idempotent tool'),
    })
    const outcome = await collectRuntimeOutcome(runId, runtime)

    assertToolCalled(outcome.events, 'idempotent')
    assertRunCompleted(outcome.events)
    expect(outcome.error).toBeUndefined()
  })

  it('sideEffect=destructive + 默认策略被拦截', async () => {
    const dangerTool = createMockTool('danger', { sideEffect: 'destructive', result: 'deleted' })
    const toolRegistry = createToolRegistry(dangerTool)
    const runtime = createTestRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'danger', args: {}, id: 'tc-danger-1' }])
          .respond(new AIMessage('done')),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: toolRegistry,
    })

    const sessionId = createSessionId('policy-destructive-blocked')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-danger', 'delete everything'),
    })
    const outcome = await collectRuntimeOutcome(runId, runtime)

    // ensureToolAllowed 在 tool.started 之前抛出，错误通过 LangGraph 传播导致 run 失败
    const hasFailed =
      outcome.error !== undefined ||
      outcome.events.some((e) => e.type === 'tool.failed') ||
      outcome.events.some((e) => e.type === 'run.failed')
    expect(hasFailed).toBe(true)
  })

  it('sideEffect=destructive + allowDestructive=true 正常执行', async () => {
    const dangerTool = createMockTool('danger', { sideEffect: 'destructive', result: 'deleted' })
    const toolRegistry = createToolRegistry(dangerTool)
    const runtime = createTestRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'danger', args: {}, id: 'tc-danger-2' }])
          .respond(new AIMessage('done')),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: toolRegistry,
    })

    const sessionId = createSessionId('policy-destructive-allowed')
    await runtime.createSession({ sessionId })

    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage('msg-danger-ok', 'delete with permission'),
      policy: {
        ...DEFAULT_EXECUTION_POLICY,
        tool: { ...DEFAULT_EXECUTION_POLICY.tool, allowDestructive: true },
      },
    })
    const outcome = await collectRuntimeOutcome(runId, runtime)

    assertToolCalled(outcome.events, 'danger')
    assertRunCompleted(outcome.events)
    expect(outcome.error).toBeUndefined()
  })

  it('未注册工具通过 ToolRegistry.executeTool 报 TOOL_NOT_FOUND', async () => {
    const registry = new ToolRegistry()

    await expect(
      registry.executeTool(
        { toolCallId: 'tc-ghost', toolName: 'ghost', args: {} },
        {
          sessionId: createSessionId('policy-not-found'),
          runId: createRunId('run_ghost'),
          toolCallId: 'tc-ghost',
        }
      )
    ).rejects.toThrow(ToolError)
  })
})

describe('ensureToolAllowed unit tests', () => {
  const baseTool = createMockTool('test')

  function withSideEffect(effect: 'none' | 'idempotent' | 'destructive'): RuntimeToolDefinition {
    return { ...baseTool, sideEffect: effect }
  }

  it('none + allowDestructive=false 不抛异常', () => {
    expect(() => ensureToolAllowed(withSideEffect('none'), false)).not.toThrow()
  })

  it('none + allowDestructive=true 不抛异常', () => {
    expect(() => ensureToolAllowed(withSideEffect('none'), true)).not.toThrow()
  })

  it('idempotent + allowDestructive=false 不抛异常', () => {
    expect(() => ensureToolAllowed(withSideEffect('idempotent'), false)).not.toThrow()
  })

  it('idempotent + allowDestructive=true 不抛异常', () => {
    expect(() => ensureToolAllowed(withSideEffect('idempotent'), true)).not.toThrow()
  })

  it('destructive + allowDestructive=false 抛 PolicyError', () => {
    expect(() => ensureToolAllowed(withSideEffect('destructive'), false)).toThrow(PolicyError)
  })

  it('destructive + allowDestructive=true 不抛异常', () => {
    expect(() => ensureToolAllowed(withSideEffect('destructive'), true)).not.toThrow()
  })
})
