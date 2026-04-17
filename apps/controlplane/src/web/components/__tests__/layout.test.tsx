/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mockUseAppStore = vi.fn()
const createSessionMock = vi.fn()

vi.mock('@copilotkit/react-ui', () => ({
  CopilotChat: ({ className }: { className?: string }) => (
    <div className={className}>copilot chat</div>
  ),
}))

vi.mock('../node-list', () => ({
  NodeList: () => <div>node list</div>,
}))

vi.mock('../workspace-panel', () => ({
  WorkspacePanel: () => <div>workspace panel</div>,
}))

vi.mock('../../stores/app-store', () => ({
  useAppStore: () => mockUseAppStore(),
}))

vi.mock('../../lib/nodes-api', () => ({
  createSession: (...args: unknown[]) => createSessionMock(...args),
}))

import { Layout } from '../layout.js'

describe('Layout', () => {
  beforeEach(() => {
    mockUseAppStore.mockReset()
    createSessionMock.mockReset()
  })

  test('renders session toolbar and creates a new session', async () => {
    const setSessionId = vi.fn()
    createSessionMock.mockResolvedValue({ sessionId: 'session-server-1' })
    mockUseAppStore.mockReturnValue({
      selectedNodeId: 'node-1',
      selectedAgentId: 'agent-1',
      sessionId: 'session_123456',
      setSessionId,
    })

    render(<Layout />)

    expect(screen.getByText('#123456')).toBeTruthy()

    fireEvent.click(screen.getByTestId('new-session-button'))

    await Promise.resolve()

    expect(createSessionMock).toHaveBeenCalledWith({ nodeId: 'node-1', agentId: 'agent-1' })
    expect(setSessionId).toHaveBeenCalledTimes(1)
    expect(setSessionId.mock.calls[0]?.[0]).toBe('session-server-1')
    expect(setSessionId.mock.calls[0]?.[1]).toEqual({ nodeId: 'node-1', agentId: 'agent-1' })
  })

  test('disables new session button and shows empty state when no node is selected', () => {
    mockUseAppStore.mockReturnValue({
      selectedNodeId: null,
      selectedAgentId: null,
      sessionId: null,
      setSessionId: vi.fn(),
    })

    render(<Layout />)

    expect((screen.getByTestId('new-session-button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('请先选择一个在线节点')).toBeTruthy()
  })
})
