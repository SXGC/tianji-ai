import type { UiNode } from '../lib/api'

interface NodeListProps {
  readonly nodes: readonly UiNode[]
  readonly selectedNodeId: string | null
  readonly onSelect: (nodeId: string, agentId: string | null) => void
}

export function NodeList(props: NodeListProps) {
  return (
    <div className="node-list">
      {props.nodes.map((node) => {
        const firstAgent = node.agents[0]
        const disabled = node.status !== 'online' || firstAgent === undefined
        const active = node.nodeId === props.selectedNodeId

        return (
          <button
            key={node.nodeId}
            className={active ? 'node-item active' : 'node-item'}
            disabled={disabled}
            onClick={() => props.onSelect(node.nodeId, firstAgent?.agentId ?? null)}
            type="button"
          >
            <strong>{node.hostname}</strong>
            <div className="node-meta">
              {node.nodeId} · {node.status} · agents: {node.agents.length}
            </div>
          </button>
        )
      })}
    </div>
  )
}
