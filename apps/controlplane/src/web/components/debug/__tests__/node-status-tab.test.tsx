/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import * as api from '../../../services/debug-api.js'
import { useDebugStore } from '../../../stores/debug-store.js'
import { NodeStatusTab } from '../node-status-tab.js'

beforeEach(() => {
  useDebugStore.getState().reset()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('NodeStatusTab', () => {
  test('激活时拉取并展示节点卡片', async () => {
    vi.spyOn(api, 'fetchDebugNodes').mockResolvedValue([
      {
        nodeId: 'n-1',
        hostname: 'h1',
        platform: 'linux',
        version: 'v1',
        status: 'online',
        executionState: 'idle',
        lastHeartbeatAt: new Date().toISOString(),
        registeredAt: new Date().toISOString(),
        agents: [{ agentId: 'a-1', type: 'native', name: 'Agent A', version: 'v1' }],
      },
    ])
    useDebugStore.setState({ panelOpen: true, tab: 'nodes' })
    render(<NodeStatusTab />)
    await vi.waitFor(() => expect(screen.getByText('n-1')).not.toBeNull())
    expect(screen.getByText(/a-1/)).not.toBeNull()
  })

  test('每 5 秒刷新一次', async () => {
    const spy = vi.spyOn(api, 'fetchDebugNodes').mockResolvedValue([])
    useDebugStore.setState({ panelOpen: true, tab: 'nodes' })
    render(<NodeStatusTab />)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    const baseline = spy.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(spy.mock.calls.length).toBe(baseline + 1)
  })

  test('切到 events tab 后不再刷新', async () => {
    const spy = vi.spyOn(api, 'fetchDebugNodes').mockResolvedValue([])
    useDebugStore.setState({ panelOpen: true, tab: 'nodes' })
    render(<NodeStatusTab />)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    useDebugStore.getState().setTab('events')
    const baseline = spy.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(spy.mock.calls.length).toBe(baseline)
  })
})
