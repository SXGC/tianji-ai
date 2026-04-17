import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoadedAgentContext } from '../context.js'

vi.mock('../context.js', () => ({
  loadAgentContext: vi.fn(),
}))

vi.mock('../session.js', () => ({
  createAgentSession: vi.fn(),
}))

vi.mock('../orchestration/index.js', () => ({
  loadDefaultOrchestrationGraph: vi.fn().mockResolvedValue({}),
  createDeepagentsExecutorFactory: vi.fn().mockReturnValue(vi.fn()),
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

let mockConnectionClosed: ReturnType<typeof createDeferred<void>>

vi.mock('@agentclientprotocol/sdk', () => ({
  AgentSideConnection: vi.fn().mockImplementation((_factory: unknown, _stream: unknown) => ({
    closed: mockConnectionClosed.promise,
  })),
  ndJsonStream: vi.fn().mockReturnValue({ readable: null, writable: null }),
}))

describe('runAcpAgent', () => {
  beforeEach(() => {
    mockConnectionClosed = createDeferred<void>()
  })

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
      paths: {
        configDir: '/tmp/tianji-test',
        agentsDir: '/tmp/tianji-test/agents',
        logsDir: '/tmp/tianji-test/logs',
        configFilePath: '/tmp/tianji-test/tianji.json',
        cliLogFilePath: '/tmp/tianji-test/logs/tianji.log',
        daemonPortPath: '/tmp/tianji-test/daemon.port',
        daemonPidPath: '/tmp/tianji-test/daemon.pid',
      },
      resolvedEnvVars: [],
      snapshotStore: {} as never,
    } satisfies LoadedAgentContext)

    const { runAcpAgent } = await import('../acp-entry.js')
    const runPromise = runAcpAgent()

    await vi.waitFor(() => {
      expect(AgentSideConnection).toHaveBeenCalledTimes(1)
    })

    mockConnectionClosed.resolve()

    await runPromise

    expect(loadAgentContext).toHaveBeenCalled()
    expect(ndJsonStream).toHaveBeenCalled()
    expect(AgentSideConnection).toHaveBeenCalledWith(expect.any(Function), expect.anything())
  })
})
