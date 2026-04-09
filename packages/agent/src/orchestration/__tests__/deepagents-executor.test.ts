/**
 * deepagents-executor 单元测试。
 *
 * 业务职责：
 * - 验证 AgentNode 被编译后，能按约定读 state、调用 SessionRuntime、写回 state。
 * - 校验图级事件 (graph.node.started / graph.node.completed) 被正确广播。
 * - 验证 input 缺失快速失败、多 output 自动追加 JSON 指令等边界行为。
 */
import { FakeListChatModel } from '@langchain/core/utils/testing'
import type { GraphEvent, RunId } from '@tianji/shared'
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
    const events: GraphEvent[] = []
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
    expect(types).toContain('graph.node.started')
    expect(types).toContain('graph.node.completed')
  })

  it('input 字段不存在时抛错', async () => {
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['ok'] }),
    })
    const node = makeAgentNode({ input: ['ghost'], output: ['a'] })
    const action = factory(node, makeCtx())

    await expect(action({}, {} as never)).rejects.toThrow(/ghost/)
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
})
