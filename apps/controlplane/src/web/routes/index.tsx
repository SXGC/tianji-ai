import { CopilotKit } from '@copilotkit/react-core'
import { createRoute } from '@tanstack/react-router'
import { useEffect } from 'react'

import { Layout } from '../components/layout'
import { useAppStore } from '../stores/app-store'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/',
  component: IndexRouteComponent,
})

export function IndexRouteComponent() {
  const { fetchNodes, selectedNodeId, selectedAgentId, nodes, selectNode } = useAppStore()

  useEffect(() => {
    void fetchNodes()
  }, [fetchNodes])

  // Auto-select first online node
  useEffect(() => {
    if (selectedNodeId !== null) return
    const firstOnline = nodes.find((n) => n.status === 'online' && n.agents[0] !== undefined)
    if (firstOnline !== undefined) {
      selectNode(firstOnline.nodeId, firstOnline.agents[0]!.agentId)
    }
  }, [nodes, selectedNodeId, selectNode])

  return (
    <CopilotKit
      runtimeUrl="/api/copilot"
      headers={{
        'x-node-id': selectedNodeId ?? '',
        'x-agent-id': selectedAgentId ?? '',
      }}
    >
      <Layout />
    </CopilotKit>
  )
}
