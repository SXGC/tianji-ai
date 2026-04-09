import { describe, expect, it, vi } from 'vitest'
import type { AgentExecutorFactory, NodeAction } from '../executors/executor-types'
import { compileOrchestrationGraph } from '../graph-compiler'
import type { OrchestrationGraph } from '../graph-schema'

function noopAction(value: unknown): NodeAction {
  return async () => ({ result: value })
}

const stubAgentFactory: AgentExecutorFactory = (node) => noopAction(`ran-${node.id}`)

function makeGraph(overrides: Partial<OrchestrationGraph> = {}): OrchestrationGraph {
  return {
    id: 'g1',
    name: 'test',
    version: 1,
    source: 'static',
    locked: false,
    state: { result: { type: 'string' } },
    nodes: [
      { id: 'a', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
      { id: 'b', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
    ],
    edges: [
      { from: '__start__', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: '__end__' },
    ],
    ...overrides,
  }
}

describe('compileOrchestrationGraph - basic nodes and edges', () => {
  it('编译简单的两节点串行图并能执行', async () => {
    const compiled = compileOrchestrationGraph(makeGraph(), {
      agentExecutorFactory: stubAgentFactory,
    })
    const finalState = await compiled.invoke({})
    expect(finalState.result).toBe('ran-b') // 后执行的覆盖
  })

  it('编译失败的图直接抛错（让 validator 错误透出）', () => {
    expect(() =>
      compileOrchestrationGraph(
        makeGraph({ edges: [{ from: 'a', to: 'b' }] }), // 缺 __start__
        { agentExecutorFactory: stubAgentFactory }
      )
    ).toThrow(/__start__/)
  })

  it('agentExecutorFactory 被调用一次每节点', () => {
    const factory = vi.fn(stubAgentFactory)
    compileOrchestrationGraph(makeGraph(), { agentExecutorFactory: factory })
    expect(factory).toHaveBeenCalledTimes(2) // a 和 b
  })
})
