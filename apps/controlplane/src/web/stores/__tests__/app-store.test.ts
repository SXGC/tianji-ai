import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '../app-store.js'

const INITIAL_STATE = useAppStore.getState()

describe('useAppStore', () => {
  afterEach(() => {
    useAppStore.setState(INITIAL_STATE)
    vi.restoreAllMocks()
  })

  describe('fetchNodes', () => {
    it('更新 nodes 并正确切换 nodesLoading 状态', async () => {
      const mockFetch = vi.fn()
      globalThis.fetch = mockFetch

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              nodeId: 'n1',
              hostname: 'host1',
              status: 'online',
              agents: [{ agentId: 'a1' }],
            },
          ]),
      })

      const loadingValues: boolean[] = []
      const unsubscribe = useAppStore.subscribe((state) => {
        loadingValues.push(state.nodesLoading)
      })

      await useAppStore.getState().fetchNodes()
      unsubscribe()

      const { nodes, nodesLoading } = useAppStore.getState()
      expect(nodesLoading).toBe(false)
      expect(nodes).toHaveLength(1)
      expect(nodes[0]).toMatchObject({
        nodeId: 'n1',
        hostname: 'host1',
        status: 'online',
        agents: [{ agentId: 'a1' }],
      })
      // nodesLoading 应先变为 true，再变为 false
      expect(loadingValues).toContain(true)
      expect(loadingValues[loadingValues.length - 1]).toBe(false)
    })

    it('fetch 失败时 nodesLoading 重置为 false', async () => {
      const mockFetch = vi.fn()
      globalThis.fetch = mockFetch

      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })

      await useAppStore.getState().fetchNodes()

      const { nodesLoading, nodes } = useAppStore.getState()
      expect(nodesLoading).toBe(false)
      expect(nodes).toHaveLength(0)
    })
  })

  describe('selectNode', () => {
    it('设置 selectedNodeId 和 selectedAgentId', () => {
      useAppStore.getState().selectNode('node-1', 'agent-1')

      const { selectedNodeId, selectedAgentId } = useAppStore.getState()
      expect(selectedNodeId).toBe('node-1')
      expect(selectedAgentId).toBe('agent-1')
    })

    it('切换节点时清空 sessionId', () => {
      useAppStore.getState().setSessionId('session-abc', { nodeId: 'node-1', agentId: 'agent-1' })
      expect(useAppStore.getState().sessionId).toBe('session-abc')

      useAppStore.getState().selectNode('node-2', 'agent-2')

      expect(useAppStore.getState().sessionId).toBeNull()
      expect(useAppStore.getState().sessionOwner).toBeNull()
    })
  })

  describe('setSessionId', () => {
    it('设置 sessionId', () => {
      useAppStore.getState().setSessionId('sess-xyz', { nodeId: 'node-1', agentId: 'agent-1' })
      expect(useAppStore.getState().sessionId).toBe('sess-xyz')
      expect(useAppStore.getState().sessionOwner).toEqual({
        nodeId: 'node-1',
        agentId: 'agent-1',
      })
    })

    it('clearSessionId 清空 sessionId', () => {
      useAppStore.getState().setSessionId('sess-xyz', { nodeId: 'node-1', agentId: 'agent-1' })
      useAppStore.getState().clearSessionId()
      expect(useAppStore.getState().sessionId).toBeNull()
      expect(useAppStore.getState().sessionOwner).toBeNull()
    })
  })

  describe('isSessionOwnedBySelectedTarget', () => {
    it('session owner 与当前选中 owner 一致时返回 true', () => {
      useAppStore.getState().selectNode('node-1', 'agent-1')
      useAppStore.getState().setSessionId('sess-xyz', { nodeId: 'node-1', agentId: 'agent-1' })

      expect(useAppStore.getState().isSessionOwnedBySelectedTarget()).toBe(true)
    })

    it('session owner 与当前选中 owner 不一致时返回 false', () => {
      useAppStore.setState({
        selectedNodeId: 'node-2',
        selectedAgentId: 'agent-2',
        sessionId: 'sess-xyz',
        sessionOwner: { nodeId: 'node-1', agentId: 'agent-1' },
      })

      expect(useAppStore.getState().isSessionOwnedBySelectedTarget()).toBe(false)
    })
  })
})
