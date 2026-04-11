import { useAppStore } from '../stores/app-store'

export function NodeList() {
  const { nodes, selectedNodeId, selectNode } = useAppStore()

  return (
    <aside className="node-list">
      <h1 className="brand">Tianji</h1>
      <p className="subtitle">Controlplane</p>
      {nodes.map((node) => {
        const firstAgent = node.agents[0]
        const disabled = node.status !== 'online' || firstAgent === undefined
        const active = node.nodeId === selectedNodeId

        return (
          <button
            key={node.nodeId}
            className={active ? 'node-item active' : 'node-item'}
            disabled={disabled}
            onClick={() => {
              if (firstAgent !== undefined) {
                selectNode(node.nodeId, firstAgent.agentId)
              }
            }}
            type="button"
          >
            <strong>{node.hostname}</strong>
            <div className="node-meta">
              {node.nodeId} · {node.status} · agents: {node.agents.length}
            </div>
          </button>
        )
      })}
    </aside>
  )
}
