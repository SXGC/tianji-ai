import type { RunId } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentExecutorFactory,
  NodeAction,
  NodeExecutorContext,
} from '../executors/executor-types'
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
      runId: 'run_test_setup' as RunId,
    })
    const finalState = await compiled.invoke({})
    expect(finalState.result).toBe('ran-b') // 后执行的覆盖
  })

  it('编译失败的图直接抛错（让 validator 错误透出）', () => {
    expect(() =>
      compileOrchestrationGraph(
        makeGraph({ edges: [{ from: 'a', to: 'b' }] }), // 缺 __start__
        {
          agentExecutorFactory: stubAgentFactory,
          runId: 'run_test_setup' as RunId,
        }
      )
    ).toThrow(/__start__/)
  })

  it('agentExecutorFactory 被调用一次每节点', () => {
    const factory = vi.fn(stubAgentFactory)
    compileOrchestrationGraph(makeGraph(), {
      agentExecutorFactory: factory,
      runId: 'run_test_setup' as RunId,
    })
    expect(factory).toHaveBeenCalledTimes(2) // a 和 b
  })

  it('图包含 acp-agent 但未提供 acpExecutorFactory 时直接抛错', () => {
    const graph: OrchestrationGraph = {
      id: 'g1',
      name: 'test',
      version: 1,
      source: 'static',
      locked: false,
      state: { result: { type: 'string' } },
      nodes: [
        { id: 'a', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
        { id: 'b', type: 'acp-agent', acp: { command: 'x' } },
      ],
      edges: [
        { from: '__start__', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: '__end__' },
      ],
    }
    expect(() =>
      compileOrchestrationGraph(graph, {
        agentExecutorFactory: stubAgentFactory,
        runId: 'run_test' as RunId,
      })
    ).toThrow(/acpExecutorFactory/)
  })

  it('factory 收到的 ctx 包含调用方提供的 runId 和 graphId', () => {
    const seen: NodeExecutorContext[] = []
    const factory: AgentExecutorFactory = (_node, ctx) => {
      seen.push(ctx)
      return async () => ({})
    }
    compileOrchestrationGraph(makeGraph(), {
      agentExecutorFactory: factory,
      runId: 'run_abc' as RunId,
    })
    expect(seen[0]?.runId).toBe('run_abc')
    expect(seen[0]?.graphId).toBe('g1')
  })
})
