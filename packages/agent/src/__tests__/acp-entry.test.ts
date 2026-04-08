import { describe, expect, it, vi } from 'vitest'

import type { LoadedAgentContext } from '../context.js'

vi.mock('../context.js', () => ({
  loadAgentContext: vi.fn(),
}))

vi.mock('../session.js', () => ({
  createAgentSession: vi.fn(),
}))

/**
 * Deferred promise helper used to control when the connection "closes".
 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const mockConnectionClosed = createDeferred<void>()

vi.mock('@agentclientprotocol/sdk', () => ({
  AgentSideConnection: vi.fn().mockImplementation((_factory: unknown, _stream: unknown) => ({
    closed: mockConnectionClosed.promise,
  })),
  ndJsonStream: vi.fn().mockReturnValue({ readable: null, writable: null }),
}))

describe('runAcpAgent', () => {
  it('creates an AgentSideConnection and awaits its closed promise', async () => {
    const { loadAgentContext } = await import('../context.js')
    const { AgentSideConnection, ndJsonStream } = await import('@agentclientprotocol/sdk')

    vi.mocked(loadAgentContext).mockResolvedValue({
      config: {},
      agent: {
        agentName: 'test',
        modelRef: 'openai/gpt-4',
        provider: 'openai',
        modelName: 'gpt-4',
        providerConfig: undefined,
        soulPath: '/tmp/SOUL.md',
        soul: 'test',
        workspace: undefined,
      },
      paths: {} as never,
      resolvedEnvVars: [],
      snapshotStore: {} as never,
    } satisfies LoadedAgentContext)

    // Resolve closed immediately so runAcpAgent completes
    mockConnectionClosed.resolve()

    const { runAcpAgent } = await import('../acp-entry.js')
    await runAcpAgent()

    expect(loadAgentContext).toHaveBeenCalled()
    expect(ndJsonStream).toHaveBeenCalled()
    expect(AgentSideConnection).toHaveBeenCalledWith(expect.any(Function), expect.anything())
  })
})
