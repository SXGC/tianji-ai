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
    set({ selectedNodeId: nodeId, selectedAgentId: agentId, sessionId: null })
  },

  sessionId: null,
  setSessionId: (id) => {
    set({ sessionId: id })
  },
}))
