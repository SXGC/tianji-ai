import type { GraphNode, OrchestrationGraph } from './graph-schema.js'

/**
 * Mermaid 渲染配置。
 */
export interface RenderOrchestrationGraphMermaidOptions {
  readonly direction?: 'TD' | 'LR'
}

/**
 * 把可序列化编排图转换为 Mermaid flowchart 文本。
 * 这里只做静态结构渲染，不掺入运行态成功/失败样式。
 */
export function renderOrchestrationGraphMermaid(
  graph: OrchestrationGraph,
  options: RenderOrchestrationGraphMermaidOptions = {}
): string {
  const direction = options.direction ?? 'TD'
  const lines: string[] = [`flowchart ${direction}`]

  lines.push(`  ${toMermaidId('__start__')}([START])`)
  lines.push(`  ${toMermaidId('__end__')}([END])`)

  for (const node of graph.nodes) {
    lines.push(renderNode(node))
  }

  for (const edge of graph.edges) {
    lines.push(renderEdge(edge.from, edge.to))
  }

  return lines.join('\n')
}

function renderNode(node: GraphNode): string {
  const id = toMermaidId(node.id)
  const label = escapeLabel(node.id)

  if (node.type === 'agent') {
    return `  ${id}[agent: ${label}]`
  }

  if (node.type === 'acp-agent') {
    return `  ${id}[[acp: ${label}]]`
  }

  if (node.type === 'router') {
    return `  ${id}{router: ${label}}`
  }

  if (node.type === 'human-gate') {
    return `  ${id}{{human: ${label}}}`
  }

  return `  ${id}([fork: ${label}])`
}

function renderEdge(from: string, to: string): string {
  return `  ${toMermaidId(from)} --> ${toMermaidId(to)}`
}

function toMermaidId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_')
}

function escapeLabel(raw: string): string {
  return raw.replace(/"/g, '\\"')
}
