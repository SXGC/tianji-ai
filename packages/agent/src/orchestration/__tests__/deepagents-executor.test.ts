/**
 * deepagents-executor 单元测试。
 *
 * 业务职责：
 * - 验证 AgentNode 被编译后，能按约定读 state、调用 SessionRuntime、写回 state。
 * - 校验图级事件 (graph.node.started / graph.node.completed) 被正确广播。
 * - 验证 input 缺失快速失败、多 output 自动追加 JSON 指令等边界行为。
 */
import { FakeListChatModel } from '@langchain/core/utils/testing'
import type { DomainEvent, GraphRunDomainEvent, RunId } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import { createDeepagentsExecutorFactory } from '../executors/deepagents-executor.js'
import type { NodeExecutorContext } from '../executors/executor-types.js'
import type { AgentNode } from '../graph-schema.js'

function makeCtx(overrides: Partial<NodeExecutorContext> = {}): NodeExecutorContext {
  return {
    runId: 'run_test' as RunId,
    graphId: 'g1',
    emitGraphEvent: vi.fn(),
    ...overrides,
  }
}

function makeAgentNode(overrides: Partial<AgentNode> = {}): AgentNode {
  return {
    id: 'node1',
    type: 'agent',
    agent: {
      model: 'fake',
      systemPrompt: 'You are helpful.',
    },
    ...overrides,
  }
}

describe('createDeepagentsExecutorFactory', () => {
  it('节点执行后从 state 读 input 并把结果写回 output', async () => {
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['hello world'] }),
    })
    const node = makeAgentNode({
      input: ['question'],
      output: ['answer'],
    })
    const action = factory(node, makeCtx())

    const update = await action({ question: 'hi?' }, {} as never)
    expect(update.answer).toBe('hello world')
  })

  it('emit graph.node.started 和 graph.node.completed', async () => {
    const events: GraphRunDomainEvent[] = []
    const ctx = makeCtx({
      emitGraphEvent: (event) => events.push(event),
    })
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['ok'] }),
    })
    const node = makeAgentNode({ input: ['q'], output: ['a'] })
    const action = factory(node, ctx)
    await action({ q: 'x' }, {} as never)

    const types = events.map((event) => event.type)
    expect(types).toContain('GraphNodeStarted')
    expect(types).toContain('GraphNodeCompleted')
  })

  it('input 字段不存在时抛错', async () => {
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['ok'] }),
    })
    const node = makeAgentNode({ input: ['ghost'], output: ['a'] })
    const action = factory(node, makeCtx())

    await expect(action({}, {} as never)).rejects.toThrow(/ghost/)
  })

  it('runtime 抛错时发射 graph.node.failed 后再 re-throw', async () => {
    const events: GraphRunDomainEvent[] = []
    const ctx = makeCtx({
      emitGraphEvent: (event) => events.push(event),
    })
    // resolveModel 直接抛错，触发 buildRuntimeForNode 内部失败路径。
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => {
        throw new Error('boom')
      },
    })
    const node = makeAgentNode({ input: ['q'], output: ['a'] })
    const action = factory(node, ctx)

    await expect(action({ q: 'x' }, {} as never)).rejects.toThrow(/boom/)

    const failedEvents = events.filter((event) => event.type === 'GraphNodeFailed')
    expect(failedEvents).toHaveLength(1)
    const failed = failedEvents[0] as { readonly error: { readonly message: string } }
    expect(failed.error.message).toContain('boom')

    // started 必须先于 failed；completed 不应出现。
    const types = events.map((event) => event.type)
    expect(types).toEqual(expect.arrayContaining(['GraphNodeStarted', 'GraphNodeFailed']))
    expect(types).not.toContain('GraphNodeCompleted')
  })

  it('多 output 字段时 systemPrompt 自动追加 JSON 指令', async () => {
    let capturedSystemPrompt: string | undefined
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['{"code":"C","tests":"T"}'] }),
      onRuntimeOptions: (options) => {
        capturedSystemPrompt = options.systemPrompt
      },
    })
    const node = makeAgentNode({
      input: ['task'],
      output: ['code', 'tests'],
    })
    const action = factory(node, makeCtx())
    const update = await action({ task: 'do it' }, {} as never)

    expect(update).toEqual({ code: 'C', tests: 'T' })
    expect(capturedSystemPrompt).toContain('JSON')
  })

  it('透传内部 DomainEvent 到 emitRuntimeEvent 回调', async () => {
    const runtimeEvents: DomainEvent[] = []
    const ctx = makeCtx({
      emitRuntimeEvent: (event) => runtimeEvents.push(event),
    })
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['result text'] }),
    })
    const node = makeAgentNode({ input: ['q'], output: ['a'] })
    const action = factory(node, ctx)
    await action({ q: 'x' }, {} as never)

    // deepagents runtime 至少会发出 RunStarted 和 RunCompleted
    const types = runtimeEvents.map((e) => e.type)
    expect(types).toContain('RunStarted')
    expect(types).toContain('RunCompleted')
  })

  it('emitRuntimeEvent 未提供时不报错（向后兼容）', async () => {
    const ctx = makeCtx() // 没有 emitRuntimeEvent
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['ok'] }),
    })
    const node = makeAgentNode({ input: ['q'], output: ['a'] })
    const action = factory(node, ctx)

    // 不报错即通过
    await expect(action({ q: 'x' }, {} as never)).resolves.toBeDefined()
  })
})
