import { InMemorySnapshotStore } from '@tianji/runtime'
import type { SessionRuntime } from '@tianji/runtime'
import * as runtimeModule from '@tianji/runtime'
import type { SessionId } from '@tianji/shared'

import type { LoadedAgentContext } from '../../context.js'
import { createAgentSession } from '../../session.js'

vi.mock('@tianji/runtime', async () => {
  const actual = await vi.importActual<typeof import('@tianji/runtime')>('@tianji/runtime')
  return {
    ...actual,
    createSessionRuntime: vi.fn(actual.createSessionRuntime),
  }
})

function createTestContext(): LoadedAgentContext {
  return {
    paths: {
      configDir: '/tmp/tianji-test/config',
      agentsDir: '/tmp/tianji-test/config/agents',
      logsDir: '/tmp/tianji-test/config/logs',
      configFilePath: '/tmp/tianji-test/config/tianji.json',
      cliLogFilePath: '/tmp/tianji-test/config/logs/tianji.log',
      daemonPortPath: '/tmp/tianji-test/config/daemon.port',
      daemonPidPath: '/tmp/tianji-test/config/daemon.pid',
    },
    config: {},
    agent: {
      agentName: 'default',
      modelRef: 'openai/gpt-4.1',
      provider: 'openai',
      modelName: 'gpt-4.1',
      providerConfig: { apiKey: 'test-key' },
      soulPath: '/tmp/tianji-test/config/agents/default/SOUL.md',
      soul: 'You are a test agent.',
      workspace: undefined,
    },
    resolvedEnvVars: [],
    snapshotStore: new InMemorySnapshotStore() as never,
  }
}

function createMockRuntime(): SessionRuntime {
  return {
    createSession: vi.fn(async (options) => ({
      sessionId: options?.sessionId ?? ('session_test' as SessionId),
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    })),
    closeSession: vi.fn(async () => ({
      sessionId: 'session_test' as SessionId,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    })),
    getSessionSnapshot: vi.fn(async () => undefined),
    getRunSnapshot: vi.fn(async () => undefined),
    runTurn: vi.fn(async () => 'run_test' as never),
    resumeRun: vi.fn(async () => 'run_test' as never),
    streamEvents: vi.fn(async function* () {}),
    cancelRun: vi.fn(() => false),
  }
}

describe('agent session e2e', () => {
  it('session uses a stable sessionId matching expected pattern', async () => {
    const mockRuntime = createMockRuntime()
    vi.spyOn(runtimeModule, 'createSessionRuntime').mockReturnValue(mockRuntime)

    const session = await createAgentSession(createTestContext())

    expect(session.sessionId).toMatch(/^session_\d+$/)
  })
})
