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

const echoStateFactory: AgentExecutorFactory = (node) => async () => {
  if (node.id === 'setter_true') return { approved: true }
  if (node.id === 'setter_false') return { approved: false }
  return {}
}

describe('compileOrchestrationGraph - router', () => {
  it('router 把控制流按条件分到不同分支', async () => {
    const graph: OrchestrationGraph = {
      id: 'g',
      name: 't',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        approved: { type: 'boolean', default: false },
        count: { type: 'number', default: 0 },
      },
      nodes: [
        { id: 'setter_true', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        {
          id: 'router1',
          type: 'router',
          condition: {
            field: 'approved',
            branches: { true: '__end__', false: 'setter_true' },
          },
        },
      ],
      edges: [
        { from: '__start__', to: 'setter_true' },
        { from: 'setter_true', to: 'router1' },
      ],
    }

    const compiled = compileOrchestrationGraph(graph, {
      agentExecutorFactory: echoStateFactory,
      runId: 'run_test_router' as RunId,
    })
    const finalState = await compiled.invoke({})
    expect(finalState.approved).toBe(true)
  })

  it('router 直接到 __end__ 时图正常结束', async () => {
    const graph: OrchestrationGraph = {
      id: 'g',
      name: 't',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        approved: { type: 'boolean', default: true },
      },
      nodes: [
        { id: 'setter_true', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        {
          id: 'router1',
          type: 'router',
          condition: {
            field: 'approved',
            branches: { true: '__end__', false: 'setter_true' },
          },
        },
      ],
      edges: [
        { from: '__start__', to: 'setter_true' },
        { from: 'setter_true', to: 'router1' },
      ],
    }

    const compiled = compileOrchestrationGraph(graph, {
      agentExecutorFactory: echoStateFactory,
      runId: 'run_test_router_end' as RunId,
    })
    const finalState = await compiled.invoke({})
    expect(finalState.approved).toBe(true)
  })
})

describe('compileOrchestrationGraph - fork/join', () => {
  it('fork 把控制流并行分发到多个目标节点', async () => {
    const calls: string[] = []
    const trackingFactory: AgentExecutorFactory = (node) => async () => {
      calls.push(node.id)
      return { logs: [node.id] }
    }

    const graph: OrchestrationGraph = {
      id: 'g',
      name: 't',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        logs: { type: 'list', reducer: 'append', default: [] },
      },
      nodes: [
        { id: 'start_node', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'left', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'right', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'merge', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'fork1', type: 'fork', targets: ['left', 'right'], join: 'merge' },
      ],
      edges: [
        { from: '__start__', to: 'start_node' },
        { from: 'start_node', to: 'fork1' },
        { from: 'merge', to: '__end__' },
      ],
    }

    const compiled = compileOrchestrationGraph(graph, {
      agentExecutorFactory: trackingFactory,
      runId: 'run_test_fork' as RunId,
    })
    const finalState = await compiled.invoke({})

    expect(calls).toContain('left')
    expect(calls).toContain('right')
    expect(calls).toContain('merge')
    expect(finalState.logs as string[]).toEqual(
      expect.arrayContaining(['start_node', 'left', 'right', 'merge'])
    )
  })
})

describe('compileOrchestrationGraph - human-gate', () => {
  it('human-gate 节点编译时被加入 interruptBefore', async () => {
    const graph: OrchestrationGraph = {
      id: 'g',
      name: 't',
      version: 1,
      source: 'static',
      locked: false,
      state: { x: { type: 'string' } },
      nodes: [
        { id: 'a', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'gate', type: 'human-gate', prompt: '请确认' },
      ],
      edges: [
        { from: '__start__', to: 'a' },
        { from: 'a', to: 'gate' },
        { from: 'gate', to: '__end__' },
      ],
    }

    expect(() =>
      compileOrchestrationGraph(graph, {
        agentExecutorFactory: stubAgentFactory,
        runId: 'run_test_human_gate' as RunId,
      })
    ).not.toThrow()
  })
})
