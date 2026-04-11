import {
  GRAPH_END,
  GRAPH_START,
  type GraphEdge,
  type GraphNode,
  type OrchestrationGraph,
  type ReservedNodeId,
} from './graph-schema.js'

export interface ValidationResult {
  readonly ok: boolean
  readonly errors: readonly string[]
}

const RESERVED_ID_LIST: readonly ReservedNodeId[] = [GRAPH_START, GRAPH_END]
const RESERVED_IDS: ReadonlySet<string> = new Set<string>(RESERVED_ID_LIST)

// ---------------------------------------------------------------------------
// 规则 1：节点 id 不能与保留字冲突，且不能重复
// ---------------------------------------------------------------------------

/** 检查单个节点 id 是否违反保留字或重复规则，返回错误消息列表。 */
function checkNodeId(node: GraphNode, seenIds: Set<string>): string[] {
  const errors: string[] = []
  if (RESERVED_IDS.has(node.id)) {
    errors.push(`节点 id 不能使用保留字 "${node.id}"`)
  }
  if (seenIds.has(node.id)) {
    errors.push(`节点 id 重复: "${node.id}"`)
  }
  return errors
}

/**
 * 校验所有节点 id，收集 seenIds，返回错误列表。
 * @returns [errors, seenIds]
 */
function validateNodeIds(nodes: readonly GraphNode[]): [string[], Set<string>] {
  const errors: string[] = []
  const seenIds = new Set<string>()
  for (const node of nodes) {
    errors.push(...checkNodeId(node, seenIds))
    seenIds.add(node.id)
  }
  return [errors, seenIds]
}

// ---------------------------------------------------------------------------
// 规则 2：必须有且仅有一条从 __start__ 出发的边
// ---------------------------------------------------------------------------

function validateStartEdgeCount(edges: readonly GraphEdge[]): string[] {
  const startEdges = edges.filter((e) => e.from === GRAPH_START)
  if (startEdges.length === 0) {
    return ['图必须包含一条从 __start__ 出发的边']
  }
  if (startEdges.length > 1) {
    return [`__start__ 只能有一条出边，当前 ${startEdges.length} 条`]
  }
  return []
}

// ---------------------------------------------------------------------------
// 规则 3：边的两端都必须存在
// ---------------------------------------------------------------------------

function checkEdgeEndpoints(edge: GraphEdge, knownIds: ReadonlySet<string>): string[] {
  const errors: string[] = []
  if (!knownIds.has(edge.from)) {
    errors.push(`边的源节点不存在: "${edge.from}"`)
  }
  if (!knownIds.has(edge.to)) {
    errors.push(`边的目标节点不存在: "${edge.to}"`)
  }
  return errors
}

function validateEdgeEndpoints(
  edges: readonly GraphEdge[],
  knownIds: ReadonlySet<string>
): string[] {
  const errors: string[] = []
  for (const edge of edges) {
    errors.push(...checkEdgeEndpoints(edge, knownIds))
  }
  return errors
}

// ---------------------------------------------------------------------------
// 规则 4：router 的 branches 目标都必须存在
// ---------------------------------------------------------------------------

function validateRouterBranches(
  node: GraphNode & { type: 'router' },
  knownIds: ReadonlySet<string>
): string[] {
  const errors: string[] = []
  for (const [branchKey, target] of Object.entries(node.condition.branches)) {
    if (!knownIds.has(target)) {
      errors.push(`router "${node.id}" 的分支 "${branchKey}" 指向不存在的节点 "${target}"`)
    }
  }
  return errors
}

// ---------------------------------------------------------------------------
// 规则 5：fork 的 targets 和 join 都必须存在
// ---------------------------------------------------------------------------

function validateForkTargets(
  node: GraphNode & { type: 'fork' },
  knownIds: ReadonlySet<string>
): string[] {
  const errors: string[] = []
  for (const target of node.targets) {
    if (!knownIds.has(target)) {
      errors.push(`fork "${node.id}" 的 targets 包含不存在的节点 "${target}"`)
    }
  }
  if (!knownIds.has(node.join)) {
    errors.push(`fork "${node.id}" 的 join 节点不存在: "${node.join}"`)
  }
  return errors
}

function validateNodeReferences(
  nodes: readonly GraphNode[],
  knownIds: ReadonlySet<string>
): string[] {
  const errors: string[] = []
  for (const node of nodes) {
    if (node.type === 'router') {
      errors.push(...validateRouterBranches(node, knownIds))
    }
    if (node.type === 'fork') {
      errors.push(...validateForkTargets(node, knownIds))
    }
  }
  return errors
}

// ---------------------------------------------------------------------------
// 规则 6：所有非控制流节点必须可达
// ---------------------------------------------------------------------------

function isControlFlowNode(node: GraphNode): boolean {
  return node.type === 'router' || node.type === 'fork'
}

function validateReachability(
  nodes: readonly GraphNode[],
  reachable: ReadonlySet<string>
): string[] {
  const errors: string[] = []
  for (const node of nodes) {
    if (isControlFlowNode(node)) continue
    if (!reachable.has(node.id)) {
      errors.push(`节点 "${node.id}" 不可达`)
    }
  }
  return errors
}

// ---------------------------------------------------------------------------
// BFS 邻接表构建辅助
// ---------------------------------------------------------------------------

function addRouterEdgesToAdjacency(
  node: GraphNode & { type: 'router' },
  adjacency: Map<string, string[]>
): void {
  const list = adjacency.get(node.id) ?? []
  for (const target of Object.values(node.condition.branches)) {
    list.push(target)
  }
  adjacency.set(node.id, list)
}

function addForkEdgesToAdjacency(
  node: GraphNode & { type: 'fork' },
  adjacency: Map<string, string[]>
): void {
  const list = adjacency.get(node.id) ?? []
  for (const target of node.targets) {
    list.push(target)
  }
  list.push(node.join)
  adjacency.set(node.id, list)
}

function buildAdjacency(graph: OrchestrationGraph): Map<string, string[]> {
  const adjacency = new Map<string, string[]>()

  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) ?? []
    list.push(edge.to)
    adjacency.set(edge.from, list)
  }

  for (const node of graph.nodes) {
    if (node.type === 'router') {
      addRouterEdgesToAdjacency(node, adjacency)
    } else if (node.type === 'fork') {
      addForkEdgesToAdjacency(node, adjacency)
    }
  }

  return adjacency
}

/**
 * 用 BFS 从 __start__ 出发收集可达节点。
 * 迭代实现，遵守 CLAUDE.md 的"禁止递归"原则。
 */
function collectReachableNodes(
  graph: OrchestrationGraph,
  knownIds: ReadonlySet<string>
): Set<string> {
  const adjacency = buildAdjacency(graph)
  const visited = new Set<string>()
  const queue: string[] = [GRAPH_START]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    const neighbors = adjacency.get(current) ?? []
    for (const next of neighbors) {
      if (knownIds.has(next) && !visited.has(next)) {
        queue.push(next)
      }
    }
  }

  return visited
}

// ---------------------------------------------------------------------------
// 公共入口
// ---------------------------------------------------------------------------

/**
 * 校验编排图的结构完整性。
 * 仅做结构检查；权限/锁定语义由调用方在编辑入口处保证。
 */
export function validateOrchestrationGraph(graph: OrchestrationGraph): ValidationResult {
  const [nodeIdErrors, seenIds] = validateNodeIds(graph.nodes)
  const knownIds = new Set<string>([...seenIds, GRAPH_START, GRAPH_END])

  const errors: string[] = [
    ...nodeIdErrors,
    ...validateStartEdgeCount(graph.edges),
    ...validateEdgeEndpoints(graph.edges, knownIds),
    ...validateNodeReferences(graph.nodes, knownIds),
    ...validateReachability(graph.nodes, collectReachableNodes(graph, knownIds)),
  ]

  return { ok: errors.length === 0, errors }
}
