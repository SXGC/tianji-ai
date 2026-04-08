import { InMemorySnapshotStore } from '@tianji/runtime'
import type { SessionRuntime } from '@tianji/runtime'
import * as runtimeModule from '@tianji/runtime'
import type { SessionId } from '@tianji/shared'

import type { LoadedAgentContext } from '../../context.js'
import { createAgentSession } from '../../session.js'
import { collectChatEvents } from '../helpers/agent-test-utils.js'

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
    streamEvents: vi.fn(async function* () {
      yield {
        type: 'run.started' as const,
        runId: 'run_test' as never,
        sessionId: 'session_test' as SessionId,
        triggerType: 'new' as const,
        parentRunId: undefined,
        timestamp: Date.now(),
      }
      yield {
        type: 'message.started' as const,
        runId: 'run_test' as never,
        messageId: 'msg_1',
        message: { id: 'msg_1', role: 'assistant' as const, content: [], createdAt: Date.now() },
        timestamp: Date.now(),
      }
      yield {
        type: 'message.completed' as const,
        runId: 'run_test' as never,
        messageId: 'msg_1',
        message: {
          id: 'msg_1',
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'hello' }],
          createdAt: Date.now(),
        },
        timestamp: Date.now(),
      }
      yield {
        type: 'run.completed' as const,
        runId: 'run_test' as never,
        sessionId: 'session_test' as SessionId,
        triggerType: 'new' as const,
        parentRunId: undefined,
        timestamp: Date.now(),
      }
    }),
    cancelRun: vi.fn(() => false),
  }
}

describe('agent session e2e', () => {
  it('session.chat returns a complete event stream', async () => {
    const mockRuntime = createMockRuntime()
    vi.spyOn(runtimeModule, 'createSessionRuntime').mockReturnValue(mockRuntime)

    const session = await createAgentSession(createTestContext())
    const events = await collectChatEvents(session, 'hi')
    const types = events.map((e) => e.type)

    expect(types).toContain('run.started')
    expect(types).toContain('message.started')
    expect(types).toContain('message.completed')
    expect(types).toContain('run.completed')
  })

  it('uses agent soul as default systemPrompt', async () => {
    const mockRuntime = createMockRuntime()
    vi.spyOn(runtimeModule, 'createSessionRuntime').mockReturnValue(mockRuntime)

    const context = createTestContext()
    const session = await createAgentSession(context)
    await collectChatEvents(session, 'hi')

    expect(mockRuntime.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'You are a test agent.',
      })
    )
  })

  it('ChatOptions.systemPrompt overrides default soul', async () => {
    const mockRuntime = createMockRuntime()
    vi.spyOn(runtimeModule, 'createSessionRuntime').mockReturnValue(mockRuntime)

    const session = await createAgentSession(createTestContext())
    await collectChatEvents(session, 'hi', { systemPrompt: 'custom prompt' })

    expect(mockRuntime.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'custom prompt',
      })
    )
  })

  it('session uses a stable sessionId matching expected pattern', async () => {
    const mockRuntime = createMockRuntime()
    vi.spyOn(runtimeModule, 'createSessionRuntime').mockReturnValue(mockRuntime)

    const session = await createAgentSession(createTestContext())

    expect(session.sessionId).toMatch(/^session_\d+$/)
  })
})
