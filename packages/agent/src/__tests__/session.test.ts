import type { SessionRuntime } from '@tianji/runtime'
import * as runtimeModule from '@tianji/runtime'
import { FileSnapshotStore } from '@tianji/runtime'
import { describe, expect, it, vi } from 'vitest'

import type { LoadedAgentContext } from '../context.js'
import { createAgentRuntime, createAgentSession } from '../session.js'

vi.mock('@tianji/runtime', async () => {
  const actual = await vi.importActual<typeof import('@tianji/runtime')>('@tianji/runtime')

  return {
    ...actual,
    createSessionRuntime: vi.fn(actual.createSessionRuntime),
  }
})

function createFakeContext(): LoadedAgentContext {
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
      providerConfig: {
        apiKey: 'test-key',
        baseUrl: 'http://example.test/v1',
        headers: {
          'x-test-header': 'enabled',
        },
      },
      soulPath: '/tmp/tianji-test/config/agents/default/SOUL.md',
      soul: '# Test Agent\n\nYou are a test agent.\n',
      workspace: undefined,
    },
    resolvedEnvVars: [],
    snapshotStore: new FileSnapshotStore('/tmp/tianji-test/runtime-snapshots'),
  }
}

describe('agent session', () => {
  it('creates runtime from loaded agent context', async () => {
    const runtime = await createAgentRuntime(createFakeContext())

    expect(runtime.createSession).toBeDefined()
    expect(runtime.runTurn).toBeDefined()
  })

  it('normalizes openai runtime model into a configured model instance', async () => {
    const runtime = (await createAgentRuntime(createFakeContext())) as SessionRuntime & {
      readonly options?: {
        readonly deepagents?: {
          readonly model?: {
            readonly model?: string
          }
          readonly providerConfig?: Record<string, unknown>
        }
      }
    }

    expect(runtime.options?.deepagents?.model?.model).toBe('gpt-4.1')
    expect(runtime.options?.deepagents?.providerConfig).toEqual({
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: 'test-key',
      baseUrl: 'http://example.test/v1',
      headers: {
        'x-test-header': 'enabled',
      },
    })
  })

  it('creates a chat session that calls runtime with context soul', async () => {
    const context = createFakeContext()
    const runtime: SessionRuntime = {
      createSession: vi.fn(async (options) => ({
        sessionId: options?.sessionId ?? ('session_test' as never),
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      })),
      closeSession: vi.fn(async () => ({
        sessionId: 'session_test' as never,
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
          type: 'run.completed' as const,
          runId: 'run_test' as never,
          sessionId: 'session_test' as never,
          triggerType: 'new' as const,
          parentRunId: undefined,
          timestamp: Date.now(),
        }
      }),
      cancelRun: vi.fn(() => false),
    }

    const createSessionRuntimeSpy = vi
      .spyOn(runtimeModule, 'createSessionRuntime')
      .mockReturnValue(runtime)

    const session = await createAgentSession(context)
    const events = []

    for await (const event of session.query('hello', { systemPrompt: context.agent.soul })) {
      events.push(event)
      if (event.type === 'run.completed') {
        break
      }
    }

    expect(session.sessionId).toBeDefined()
    expect(events.length).toBeGreaterThan(0)
    expect(createSessionRuntimeSpy).toHaveBeenCalledWith({
      deepagents: {
        model: 'openai:gpt-4.1',
        providerConfig: {
          provider: 'openai',
          model: 'gpt-4.1',
          apiKey: 'test-key',
          baseUrl: 'http://example.test/v1',
          headers: {
            'x-test-header': 'enabled',
          },
        },
        backend: expect.any(Object),
      },
      snapshotStore: context.snapshotStore,
    })
    expect(runtime.createSession).toHaveBeenCalledWith({ sessionId: session.sessionId })
    expect(events.some((event) => event.type === 'run.completed')).toBe(true)
    expect(runtime.createSession).toHaveBeenCalledTimes(1)
    expect(runtime.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.sessionId,
        systemPrompt: context.agent.soul,
      })
    )
  })
})
