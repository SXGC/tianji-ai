import { create } from 'zustand'

import { type UiNode, fetchNodes } from '../lib/nodes-api.js'

export interface AppState {
  nodes: UiNode[]
  nodesLoading: boolean
  fetchNodes: () => Promise<void>

  selectedNodeId: string | null
  selectedAgentId: string | null
  selectNode: (nodeId: string, agentId: string) => void

  sessionId: string | null
  setSessionId: (id: string) => void
  clearSessionId: () => void
}

export const useAppStore = create<AppState>((set) => ({
  nodes: [],
  nodesLoading: false,
  fetchNodes: async () => {
    set({ nodesLoading: true })
    try {
      const nodes = await fetchNodes()
      set({ nodes: [...nodes], nodesLoading: false })
    } catch {
      set({ nodesLoading: false })
    }
  },

  selectedNodeId: null,
  selectedAgentId: null,
  selectNode: (nodeId, agentId) => {
    // 切换 owner 边界时必须重建 session，避免跨 node/agent 复用。
    set({ selectedNodeId: nodeId, selectedAgentId: agentId, sessionId: null })
  },

  sessionId: null,
  setSessionId: (id) => {
    set({ sessionId: id })
  },
  clearSessionId: () => {
    set({ sessionId: null })
  },
}))
