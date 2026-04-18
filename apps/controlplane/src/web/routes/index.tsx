import { CopilotKit } from '@copilotkit/react-core'
import { createRoute } from '@tanstack/react-router'
import { useEffect } from 'react'

import { Layout } from '../components/layout'
import { createSession } from '../lib/nodes-api'
import { useAppStore } from '../stores/app-store'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/',
  component: IndexRouteComponent,
})

export function IndexRouteComponent() {
  const {
    fetchNodes,
    selectedNodeId,
    selectedAgentId,
    nodes,
    selectNode,
    sessionId,
    clearSessionId,
    isSessionOwnedBySelectedTarget,
    setSessionId,
  } = useAppStore()

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

  // 前端只负责初始化体验上的 sessionId，真正的 owner 约束在后端请求边界校验。
  useEffect(() => {
    if (selectedNodeId === null || selectedAgentId === null) return
    if (sessionId !== null && !isSessionOwnedBySelectedTarget()) {
      clearSessionId()
      return
    }
    if (sessionId !== null) return
    void createSession({ nodeId: selectedNodeId, agentId: selectedAgentId }).then((result) => {
      setSessionId(result.sessionId, { nodeId: selectedNodeId, agentId: selectedAgentId })
    })
  }, [
    clearSessionId,
    isSessionOwnedBySelectedTarget,
    selectedAgentId,
    selectedNodeId,
    sessionId,
    setSessionId,
  ])

  if (selectedNodeId === null || selectedAgentId === null || sessionId === null) {
    return <Layout />
  }

  return (
    <CopilotKit
      runtimeUrl="/api/copilot"
      headers={{
        'x-node-id': selectedNodeId,
        'x-agent-id': selectedAgentId,
        'x-session-id': sessionId,
      }}
    >
      <Layout />
    </CopilotKit>
  )
}
