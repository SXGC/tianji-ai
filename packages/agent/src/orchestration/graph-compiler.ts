import { type CompiledStateGraph, END, START, StateGraph } from '@langchain/langgraph'
import type { ObserverLogger } from '@tianji/observer'
import type { RunId } from '@tianji/shared'
import type {
  AcpExecutorFactory,
  AgentExecutorFactory,
  NodeAction,
  NodeExecutorContext,
} from './executors/executor-types.js'
import {
  type AcpAgentNode,
  type AgentNode,
  type ForkNode,
  GRAPH_END,
  GRAPH_START,
  type GraphNode,
  type HumanGateNode,
  type OrchestrationGraph,
  type RouterNode,
} from './graph-schema.js'
import { validateOrchestrationGraph } from './graph-validator.js'
import { compileStateChannels } from './state-channels.js'

export interface CompileOptions {
  readonly agentExecutorFactory: AgentExecutorFactory
  readonly acpExecutorFactory?: AcpExecutorFactory
  readonly checkpointer?: unknown
  readonly store?: unknown
  readonly observer?: ObserverLogger
  readonly runId?: RunId
  readonly emitGraphEvent?: (event: never) => void
}

/**
 * 把 OrchestrationGraph 编译为 LangGraph CompiledStateGraph。
 * 编译流程：
 *  1. 校验图结构
 *  2. 编译 state → Annotation.Root
 *  3. 添加节点 (agent / acp-agent / human-gate)
 *  4. 添加边 (普通边 / router 条件边 / fork Send)
 *  5. compile()
 */
export function compileOrchestrationGraph(
  graph: OrchestrationGraph,
  options: CompileOptions
): CompiledStateGraph<unknown, unknown, string> {
  const validation = validateOrchestrationGraph(graph)
  if (!validation.ok) {
    throw new Error(`编排图校验失败:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`)
  }

  const stateAnnotation = compileStateChannels(graph.state)

  // 任意类型签名以便 langgraph 接受
  const builder = new StateGraph(stateAnnotation as never) as unknown as StateGraph<unknown>

  const ctx: NodeExecutorContext = {
    runId: options.runId ?? ('run_local' as RunId),
    graphId: graph.id,
    observer: options.observer,
    emitGraphEvent: () => undefined, // 默认空实现，graph-runner 会替换
  }

  const nodeMap = new Map<string, GraphNode>()
  for (const node of graph.nodes) nodeMap.set(node.id, node)

  // Step 3: 添加节点
  for (const node of graph.nodes) {
    if (node.type === 'agent') {
      const action = options.agentExecutorFactory(node, ctx)
      ;(builder as { addNode: (id: string, action: NodeAction) => unknown }).addNode(
        node.id,
        action
      )
    } else if (node.type === 'acp-agent') {
      if (!options.acpExecutorFactory) {
        throw new Error(`图包含 acp-agent 节点 "${node.id}" 但未提供 acpExecutorFactory`)
      }
      const action = options.acpExecutorFactory(node, ctx)
      ;(builder as { addNode: (id: string, action: NodeAction) => unknown }).addNode(
        node.id,
        action
      )
    } else if (node.type === 'human-gate') {
      ;(builder as { addNode: (id: string, action: NodeAction) => unknown }).addNode(
        node.id,
        createHumanGateAction(node)
      )
    }
    // router / fork: 不创建节点，留到 Step 4
  }

  // Step 4: 添加边
  addEdges(builder, graph, nodeMap)

  // Step 5: 编译
  const compiled = (
    builder as unknown as {
      compile: (opts?: unknown) => CompiledStateGraph<unknown, unknown, string>
    }
  ).compile({
    checkpointer: options.checkpointer,
    store: options.store,
    interruptBefore: collectHumanGateIds(graph),
  })

  return compiled
}

function addEdges(
  builder: StateGraph<unknown>,
  graph: OrchestrationGraph,
  nodeMap: ReadonlyMap<string, GraphNode>
): void {
  // 内部函数实现逐步在后续 task 扩展。
  // 当前 task 6 只支持普通边。后续 task 7/8 扩展 router/fork。
  void nodeMap
  const builderAny = builder as unknown as {
    addEdge: (from: string, to: string) => unknown
  }
  for (const edge of graph.edges) {
    const fromKey = edge.from === GRAPH_START ? START : edge.from
    const toKey = edge.to === GRAPH_END ? END : edge.to
    builderAny.addEdge(fromKey, toKey)
  }
}

function createHumanGateAction(node: HumanGateNode): NodeAction {
  return async (state) => {
    // 实际的中断由 compile({ interruptBefore }) 触发；
    // 节点函数本身只是一个 pass-through
    void node
    return state
  }
}

function collectHumanGateIds(graph: OrchestrationGraph): string[] {
  return graph.nodes.filter((n): n is HumanGateNode => n.type === 'human-gate').map((n) => n.id)
}

// 占位：后续 task 实现
export function _internalRouterStub(_: RouterNode): void {
  void _
}
export function _internalForkStub(_: ForkNode, __: AgentNode | AcpAgentNode): void {
  void _
  void __
}
