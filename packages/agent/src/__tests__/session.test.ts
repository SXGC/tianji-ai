import type { SessionRuntime } from '@tianji/runtime'
import * as runtimeModule from '@tianji/runtime'
import { FileSnapshotStore } from '@tianji/runtime'
import { describe, expect, it, vi } from 'vitest'

import type { LoadedAgentContext } from '../context.js'
import { createAgentRuntime, createAgentSession } from '../session.js'

function createFakeContext(): LoadedAgentContext {
  return {
    paths: {
      configDir: '/tmp/tianji-test/config',
      agentsDir: '/tmp/tianji-test/config/agents',
      logsDir: '/tmp/tianji-test/config/logs',
      configFilePath: '/tmp/tianji-test/config/tianji.json',
      cliLogFilePath: '/tmp/tianji-test/config/logs/tianji.log',
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
    },
    resolvedEnvVars: [],
    snapshotStore: new FileSnapshotStore('/tmp/tianji-test/runtime-snapshots'),
  }
}

describe('agent session', () => {
  it('creates runtime from loaded agent context', () => {
    const runtime = createAgentRuntime(createFakeContext())

    expect(runtime.createSession).toBeDefined()
    expect(runtime.runTurn).toBeDefined()
  })

  it('normalizes openai runtime model into a configured model instance', () => {
    const runtime = createAgentRuntime(createFakeContext()) as SessionRuntime & {
      readonly options?: {
        readonly deepagents?: {
          readonly model?: unknown
          readonly providerConfig?: Record<string, unknown>
        }
      }
    }

    expect(runtime.options?.deepagents?.model).toMatchObject({
      model: 'gpt-4.1',
    })
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
      closeSession: vi.fn(),
      getSessionSnapshot: vi.fn(),
      getRunSnapshot: vi.fn(),
      runTurn: vi.fn(async () => 'run_test' as never),
      resumeRun: vi.fn(),
      streamEvents: vi.fn(async function* () {
        yield {
          type: 'run.completed' as const,
          runId: 'run_test' as never,
          sessionId: 'session_test' as never,
          timestamp: Date.now(),
        }
      }),
      cancelRun: vi.fn(),
    }

    const createSessionRuntimeSpy = vi
      .spyOn(runtimeModule, 'createSessionRuntime')
      .mockReturnValue(runtime)

    const session = createAgentSession(context)
    const events = []

    for await (const event of session.chat('hello')) {
      events.push(event)
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
      },
      snapshotStore: context.snapshotStore,
    })
    expect(runtime.createSession).toHaveBeenCalledWith({ sessionId: session.sessionId })
    expect(runtime.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: session.sessionId,
        systemPrompt: context.agent.soul,
      })
    )
  })
})
