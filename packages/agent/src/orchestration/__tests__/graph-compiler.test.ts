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

function countOccurrences(values: readonly string[], target: string): number {
  return values.filter((value) => value === target).length
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

  it('节点声明未知 skill id 时编译直接失败且不会创建节点执行器', () => {
    const factory = vi.fn(stubAgentFactory)
    const graph = makeGraph({
      nodes: [
        {
          id: 'a',
          type: 'agent',
          agent: {
            model: 'fake',
            systemPrompt: 'sp',
            skills: ['unknown-skill'],
          },
        },
      ],
      edges: [{ from: '__start__', to: 'a' }],
    })

    expect(() =>
      compileOrchestrationGraph(graph, {
        agentExecutorFactory: factory,
        runId: 'run_test_capability_skill' as RunId,
      })
    ).toThrow(/Capability skills is outside graph-run upper bound: unknown-skill/)
    expect(factory).not.toHaveBeenCalled()
  })

  it('节点声明未知 tool 时编译直接失败且不会创建节点执行器', () => {
    const factory = vi.fn(stubAgentFactory)
    const graph = makeGraph({
      nodes: [
        {
          id: 'a',
          type: 'agent',
          agent: {
            model: 'fake',
            systemPrompt: 'sp',
            tools: ['unknown-tool'],
          },
        },
      ],
      edges: [{ from: '__start__', to: 'a' }],
    })

    expect(() =>
      compileOrchestrationGraph(graph, {
        agentExecutorFactory: factory,
        runId: 'run_test_capability_tool' as RunId,
      })
    ).toThrow(/Capability tools is outside graph-run upper bound: unknown-tool/)
    expect(factory).not.toHaveBeenCalled()
  })

  it('节点声明超出 graph-run 能力上限的 mcpTargets 时编译直接失败且不会创建节点执行器', () => {
    const factory = vi.fn(stubAgentFactory)
    const graph = makeGraph({
      nodes: [
        {
          id: 'a',
          type: 'agent',
          agent: {
            model: 'fake',
            systemPrompt: 'sp',
            mcpTargets: ['unknown-mcp-target'],
          },
        },
      ],
      edges: [{ from: '__start__', to: 'a' }],
    })

    expect(() =>
      compileOrchestrationGraph(graph, {
        agentExecutorFactory: factory,
        runId: 'run_test_capability_mcp' as RunId,
      })
    ).toThrow(/Capability mcpTargets is outside graph-run upper bound: unknown-mcp-target/)
    expect(factory).not.toHaveBeenCalled()
  })

  it('编译阶段使用调用方提供的能力上限和 resolver，并把它们透传给节点执行器上下文', () => {
    const upperBound = {
      skills: ['allowed-skill'],
      tools: ['allowed-tool'],
      mcpTargets: ['allowed-target'],
    } as const
    const resolver = vi.fn(() => ({
      skills: ['allowed-skill'],
      tools: ['allowed-tool'],
      mcpTargets: ['allowed-target'],
    }))
    const seen: NodeExecutorContext[] = []
    const factory = vi.fn((_node, ctx) => {
      seen.push(ctx)
      return async () => ({})
    })
    const graph = makeGraph({
      nodes: [
        {
          id: 'a',
          type: 'agent',
          agent: {
            model: 'fake',
            systemPrompt: 'sp',
            skills: ['allowed-skill'],
            tools: ['allowed-tool'],
            mcpTargets: ['allowed-target'],
          },
        },
      ],
      edges: [{ from: '__start__', to: 'a' }],
    })

    expect(() =>
      compileOrchestrationGraph(graph, {
        agentExecutorFactory: factory,
        runId: 'run_test_capability_options' as RunId,
        graphRunCapabilityUpperBound: upperBound,
        resolveNodeCapabilities: resolver,
      })
    ).not.toThrow()
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith(graph.nodes[0], upperBound)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(seen[0]?.graphRunCapabilityUpperBound).toBe(upperBound)
    expect(seen[0]?.resolveNodeCapabilities).toBe(resolver)
  })
})

const echoStateFactory: AgentExecutorFactory = (node) => async () => {
  if (node.id === 'setter_true') return { approved: true }
  if (node.id === 'setter_false') return { approved: false }
  return {}
}

describe('compileOrchestrationGraph - router', () => {
  it('router 命中 false 分支时只执行对应目标节点', async () => {
    const calls: string[] = []
    const trackingFactory: AgentExecutorFactory = (node) => async () => {
      calls.push(node.id)
      if (node.id === 'setter_false') return { approved: false }
      if (node.id === 'false_branch') return { route: 'false_branch' }
      if (node.id === 'true_branch') return { route: 'true_branch' }
      return {}
    }

    const graph: OrchestrationGraph = {
      id: 'g',
      name: 't',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        approved: { type: 'boolean', default: true },
        route: { type: 'string', default: '' },
      },
      nodes: [
        { id: 'setter_false', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'false_branch', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'true_branch', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        {
          id: 'router1',
          type: 'router',
          condition: {
            field: 'approved',
            branches: { true: 'true_branch', false: 'false_branch' },
          },
        },
      ],
      edges: [
        { from: '__start__', to: 'setter_false' },
        { from: 'setter_false', to: 'router1' },
        { from: 'false_branch', to: '__end__' },
        { from: 'true_branch', to: '__end__' },
      ],
    }

    const compiled = compileOrchestrationGraph(graph, {
      agentExecutorFactory: trackingFactory,
      runId: 'run_test_router_false_branch' as RunId,
    })
    const finalState = await compiled.invoke({})
    expect(finalState.approved).toBe(false)
    expect(finalState.route).toBe('false_branch')
    expect(calls).toEqual(['setter_false', 'false_branch'])
  })

  it('router 命中 __end__ 分支时不会继续执行其他节点', async () => {
    const calls: string[] = []
    const trackingFactory: AgentExecutorFactory = (node) => async () => {
      calls.push(node.id)
      if (node.id === 'setter_true') return { approved: true }
      if (node.id === 'should_not_run') return { route: 'unexpected' }
      return {}
    }

    const graph: OrchestrationGraph = {
      id: 'g',
      name: 't',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        approved: { type: 'boolean', default: true },
        route: { type: 'string', default: '' },
      },
      nodes: [
        { id: 'setter_true', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'should_not_run', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        {
          id: 'router1',
          type: 'router',
          condition: {
            field: 'approved',
            branches: { true: '__end__', false: 'should_not_run' },
          },
        },
      ],
      edges: [
        { from: '__start__', to: 'setter_true' },
        { from: 'setter_true', to: 'router1' },
        { from: 'should_not_run', to: '__end__' },
      ],
    }

    const compiled = compileOrchestrationGraph(graph, {
      agentExecutorFactory: trackingFactory,
      runId: 'run_test_router_end' as RunId,
    })
    const finalState = await compiled.invoke({})
    expect(finalState.approved).toBe(true)
    expect(finalState.route).toBe('')
    expect(calls).toEqual(['setter_true'])
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
    const logs = finalState.logs as string[]

    expect(countOccurrences(calls, 'start_node')).toBe(1)
    expect(countOccurrences(calls, 'left')).toBe(1)
    expect(countOccurrences(calls, 'right')).toBe(1)
    expect(countOccurrences(calls, 'merge')).toBe(1)
    expect(logs).toHaveLength(4)
    expect(countOccurrences(logs, 'start_node')).toBe(1)
    expect(countOccurrences(logs, 'left')).toBe(1)
    expect(countOccurrences(logs, 'right')).toBe(1)
    expect(countOccurrences(logs, 'merge')).toBe(1)
  })
})

describe('compileOrchestrationGraph - human-gate', () => {
  it('human-gate 会在 gate 前中断，且 gate 后节点不会执行', async () => {
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
      state: { logs: { type: 'list', reducer: 'append', default: [] } },
      nodes: [
        { id: 'a', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'gate', type: 'human-gate', prompt: '请确认' },
        { id: 'after_gate', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
      ],
      edges: [
        { from: '__start__', to: 'a' },
        { from: 'a', to: 'gate' },
        { from: 'gate', to: 'after_gate' },
        { from: 'after_gate', to: '__end__' },
      ],
    }

    const compiled = compileOrchestrationGraph(graph, {
      agentExecutorFactory: trackingFactory,
      runId: 'run_test_human_gate' as RunId,
    })
    const finalState = (await compiled.invoke({})) as Record<string, unknown>

    expect(calls).toEqual(['a'])
    expect(finalState.logs).toEqual(['a'])
    expect(finalState).toHaveProperty('__interrupt__')
    expect(Array.isArray(finalState.__interrupt__)).toBe(true)
  })
})
