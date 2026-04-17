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
  sessionOwner: { nodeId: string; agentId: string } | null
  setSessionId: (id: string, owner: { nodeId: string; agentId: string }) => void
  clearSessionId: () => void
  isSessionOwnedBySelectedTarget: () => boolean
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
    set({ selectedNodeId: nodeId, selectedAgentId: agentId, sessionId: null, sessionOwner: null })
  },

  sessionId: null,
  sessionOwner: null,
  setSessionId: (id, owner) => {
    set({
      sessionId: id,
      sessionOwner: owner,
    })
  },
  clearSessionId: () => {
    set({ sessionId: null, sessionOwner: null })
  },
  isSessionOwnedBySelectedTarget: () => {
    const state = useAppStore.getState()
    return (
      state.sessionId !== null &&
      state.sessionOwner !== null &&
      state.selectedNodeId !== null &&
      state.selectedAgentId !== null &&
      state.sessionOwner.nodeId === state.selectedNodeId &&
      state.sessionOwner.agentId === state.selectedAgentId
    )
  },
}))
