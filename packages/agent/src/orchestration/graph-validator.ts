import {
  GRAPH_END,
  GRAPH_START,
  type GraphNode,
  type OrchestrationGraph,
  type ReservedNodeId,
} from './graph-schema'

export interface ValidationResult {
  readonly ok: boolean
  readonly errors: readonly string[]
}

const RESERVED_ID_LIST: readonly ReservedNodeId[] = [GRAPH_START, GRAPH_END]
const RESERVED_IDS: ReadonlySet<string> = new Set<string>(RESERVED_ID_LIST)

/**
 * 校验编排图的结构完整性。
 * 仅做结构检查；权限/锁定语义由调用方在编辑入口处保证。
 */
export function validateOrchestrationGraph(graph: OrchestrationGraph): ValidationResult {
  const errors: string[] = []

  // 1. 节点 id 不能与保留字冲突
  const seenIds = new Set<string>()
  for (const node of graph.nodes) {
    if (RESERVED_IDS.has(node.id)) {
      errors.push(`节点 id 不能使用保留字 "${node.id}"`)
    }
    if (seenIds.has(node.id)) {
      errors.push(`节点 id 重复: "${node.id}"`)
    }
    seenIds.add(node.id)
  }

  const knownIds = new Set<string>([...seenIds, GRAPH_START, GRAPH_END])

  // 2. 必须有且仅有一条从 __start__ 出发的边
  const startEdges = graph.edges.filter((e) => e.from === GRAPH_START)
  if (startEdges.length === 0) {
    errors.push('图必须包含一条从 __start__ 出发的边')
  } else if (startEdges.length > 1) {
    errors.push(`__start__ 只能有一条出边，当前 ${startEdges.length} 条`)
  }

  // 3. 边的两端都必须存在
  for (const edge of graph.edges) {
    if (!knownIds.has(edge.from)) {
      errors.push(`边的源节点不存在: "${edge.from}"`)
    }
    if (!knownIds.has(edge.to)) {
      errors.push(`边的目标节点不存在: "${edge.to}"`)
    }
  }

  // 4. router 的 branches 目标都必须存在
  // 5. fork 的 targets 和 join 都必须存在
  for (const node of graph.nodes) {
    if (node.type === 'router') {
      for (const [branchKey, target] of Object.entries(node.condition.branches)) {
        if (!knownIds.has(target)) {
          errors.push(`router "${node.id}" 的分支 "${branchKey}" 指向不存在的节点 "${target}"`)
        }
      }
    }
    if (node.type === 'fork') {
      for (const target of node.targets) {
        if (!knownIds.has(target)) {
          errors.push(`fork "${node.id}" 的 targets 包含不存在的节点 "${target}"`)
        }
      }
      if (!knownIds.has(node.join)) {
        errors.push(`fork "${node.id}" 的 join 节点不存在: "${node.join}"`)
      }
    }
  }

  // 6. 所有非控制流节点必须可达（从 __start__ 出发的 BFS，迭代式）
  const reachable = collectReachableNodes(graph, knownIds)
  for (const node of graph.nodes) {
    if (isControlFlowNode(node)) continue
    if (!reachable.has(node.id)) {
      errors.push(`节点 "${node.id}" 不可达`)
    }
  }

  return { ok: errors.length === 0, errors }
}

function isControlFlowNode(node: GraphNode): boolean {
  return node.type === 'router' || node.type === 'fork'
}

/**
 * 用 BFS 从 __start__ 出发收集可达节点。
 * 迭代实现，遵守 CLAUDE.md 的"禁止递归"原则。
 */
function collectReachableNodes(
  graph: OrchestrationGraph,
  knownIds: ReadonlySet<string>
): Set<string> {
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) ?? []
    list.push(edge.to)
    adjacency.set(edge.from, list)
  }
  // router 的分支也算出边
  // fork 的 targets 也算出边
  for (const node of graph.nodes) {
    if (node.type === 'router') {
      const list = adjacency.get(node.id) ?? []
      for (const target of Object.values(node.condition.branches)) {
        list.push(target)
      }
      adjacency.set(node.id, list)
    }
    if (node.type === 'fork') {
      const list = adjacency.get(node.id) ?? []
      for (const target of node.targets) {
        list.push(target)
      }
      list.push(node.join)
      adjacency.set(node.id, list)
    }
  }

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
