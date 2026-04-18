import { type CompiledStateGraph, END, START, Send, StateGraph } from '@langchain/langgraph'
import type { ObserverLogger } from '@tianji/observer'
import type { SnapshotStore } from '@tianji/runtime'
import type {
  DomainEvent,
  GraphRunCapabilityUpperBound,
  GraphRunDomainEvent,
  RunId,
  SessionId,
} from '@tianji/shared'
import {
  createGraphRunCapabilityUpperBound,
  resolveNodeCapabilities as defaultResolveNodeCapabilities,
} from './capability-resolver.js'
import type {
  AcpExecutorFactory,
  AgentExecutorFactory,
  NodeAction,
  NodeExecutorContext,
} from './executors/executor-types.js'
import {
  type ForkNode,
  GRAPH_END,
  GRAPH_START,
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
  readonly runId: RunId
  readonly emitGraphEvent?: (event: GraphRunDomainEvent) => void
  readonly emitRuntimeEvent?: (event: DomainEvent) => void
  /** graph-run 级能力上限；未提供时默认空 allowlist。 */
  readonly graphRunCapabilityUpperBound?: GraphRunCapabilityUpperBound
  /** graph-run 级节点能力解析入口；未提供时使用默认 resolver。 */
  readonly resolveNodeCapabilities?: NonNullable<NodeExecutorContext['resolveNodeCapabilities']>
  /**
   * 顶层 run 的 abortSignal。
   * 会被塞入 NodeExecutorContext，让节点执行器在 runtime 调用处透传。
   */
  readonly abortSignal?: AbortSignal
  /** 跨轮持久化的会话 ID，透传至 NodeExecutorContext 供执行器做 open-or-create。 */
  readonly sessionId?: SessionId
  /** 与 sessionId 配套的持久化快照存储，注入后执行器不再使用 InMemorySnapshotStore。 */
  readonly snapshotStore?: SnapshotStore
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
    const errorList = validation.errors.map((e) => `  - ${e}`).join('\n')
    throw new Error(`编排图校验失败:\n${errorList}`)
  }

  const graphRunCapabilityUpperBound =
    options.graphRunCapabilityUpperBound ?? createGraphRunCapabilityUpperBound()
  const resolveNodeCapabilities: NonNullable<NodeExecutorContext['resolveNodeCapabilities']> =
    options.resolveNodeCapabilities ?? defaultResolveNodeCapabilities

  validateGraphCapabilities(graph, graphRunCapabilityUpperBound, resolveNodeCapabilities)

  const stateAnnotation = compileStateChannels(graph.state)

  // 任意类型签名以便 langgraph 接受
  const builder = new StateGraph(stateAnnotation as never) as unknown as StateGraph<unknown>

  const ctx: NodeExecutorContext = {
    runId: options.runId,
    graphId: graph.id,
    observer: options.observer,
    emitGraphEvent: options.emitGraphEvent ?? (() => undefined),
    emitRuntimeEvent: options.emitRuntimeEvent,
    graphRunCapabilityUpperBound,
    resolveNodeCapabilities,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    snapshotStore: options.snapshotStore,
  }

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
        createHumanGateAction()
      )
    }
    // router / fork: 不创建节点，留到 Step 4
  }

  // Step 4: 添加边
  addEdges(builder, graph)

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

function validateGraphCapabilities(
  graph: OrchestrationGraph,
  graphRunCapabilityUpperBound: GraphRunCapabilityUpperBound,
  resolveNodeCapabilities: NonNullable<NodeExecutorContext['resolveNodeCapabilities']>
): void {
  for (const node of graph.nodes) {
    if (node.type !== 'agent') {
      continue
    }
    resolveNodeCapabilities(node, graphRunCapabilityUpperBound)
  }
}

/** langgraph builder 的最小类型接口，用于绕过泛型限制 */
type BuilderApi = {
  addEdge: (from: string, to: string) => unknown
  addConditionalEdges: (
    source: string,
    path: (state: Record<string, unknown>) => string | Send | (string | Send)[],
    pathMap?: Record<string, string>
  ) => unknown
}

/** 为 router 节点添加条件边（读取 state 字段，按值路由） */
function addRouterEdge(builderApi: BuilderApi, fromKey: string, router: RouterNode): void {
  const pathMap: Record<string, string> = {}
  for (const [branchKey, target] of Object.entries(router.condition.branches)) {
    pathMap[branchKey] = target === GRAPH_END ? END : target
  }
  builderApi.addConditionalEdges(fromKey, (state) => String(state[router.condition.field]), pathMap)
}

/** 为 fork 节点添加并行扇出边（Send 语义），并连接每个分支到 join 节点 */
function addForkEdge(builderApi: BuilderApi, fromKey: string, fork: ForkNode): void {
  const targets = [...fork.targets]
  builderApi.addConditionalEdges(
    fromKey,
    (state) => targets.map((t) => new Send(t, state)),
    Object.fromEntries(targets.map((t) => [t, t]))
  )
  for (const target of fork.targets) {
    builderApi.addEdge(target, fork.join)
  }
}

/** 为普通边添加直连边 */
function addPlainEdge(builderApi: BuilderApi, fromKey: string, toRaw: string): void {
  const toKey = toRaw === GRAPH_END ? END : toRaw
  builderApi.addEdge(fromKey, toKey)
}

function addEdges(builder: StateGraph<unknown>, graph: OrchestrationGraph): void {
  // 支持普通边、router 条件边、fork Send 并行扇出
  const builderApi = builder as unknown as BuilderApi

  // 收集所有 router / fork 节点，供指向它们的边在处理时改写为条件边
  const routerNodes = new Map<string, RouterNode>()
  const forkNodes = new Map<string, ForkNode>()
  for (const node of graph.nodes) {
    if (node.type === 'router') routerNodes.set(node.id, node)
    if (node.type === 'fork') forkNodes.set(node.id, node)
  }

  // 遍历边。若目标是 router / fork，改写为 addConditionalEdges；它们自身不是真实节点
  for (const edge of graph.edges) {
    const fromKey = edge.from === GRAPH_START ? START : edge.from
    const router = routerNodes.get(edge.to)
    const fork = forkNodes.get(edge.to)

    if (router) {
      addRouterEdge(builderApi, fromKey, router)
    } else if (fork) {
      addForkEdge(builderApi, fromKey, fork)
    } else {
      addPlainEdge(builderApi, fromKey, edge.to)
    }
  }
}

function createHumanGateAction(): NodeAction {
  // 实际的中断由 compile({ interruptBefore }) 触发；
  // 节点函数本身只是一个 pass-through
  return async (state) => state
}

function collectHumanGateIds(graph: OrchestrationGraph): string[] {
  return graph.nodes.filter((n): n is HumanGateNode => n.type === 'human-gate').map((n) => n.id)
}
