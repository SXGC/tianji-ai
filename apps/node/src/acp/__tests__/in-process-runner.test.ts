import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LoadedAgentContext } from '@tianji/agent'
import type { RuntimeEvent } from '@tianji/shared'

const createAgentSessionMock = vi.fn()
const loadAgentContextForNameMock = vi.fn()

vi.mock('@tianji/agent', () => ({
  createAgentSession: createAgentSessionMock,
  loadAgentContextForName: loadAgentContextForNameMock,
}))

function createContext(): LoadedAgentContext {
  return {
    paths: {
      configDir: '/tmp/test',
      agentsDir: '/tmp/test/agents',
      logsDir: '/tmp/test/logs',
      configFilePath: '/tmp/test/tianji.json',
      cliLogFilePath: '/tmp/test/logs/tianji.log',
      daemonPortPath: '/tmp/test/daemon.port',
      daemonPidPath: '/tmp/test/daemon.pid',
    },
    config: {},
    agent: {
      agentName: 'default',
      modelRef: 'openai/gpt-4o-mini',
      provider: 'openai',
      modelName: 'gpt-4o-mini',
      providerConfig: undefined,
      soulPath: '/tmp/test/agents/default/SOUL.md',
      soul: 'test soul',
    },
    resolvedEnvVars: [],
    snapshotStore: {} as never,
  }
}

async function collectEvents(iterable: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  for await (const event of iterable) {
    events.push(event)
  }
  return events
}

describe('InProcessAgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadAgentContextForNameMock.mockResolvedValue(createContext())
  })

  it('creates an in-process session and streams native events', async () => {
    const completedEvent: RuntimeEvent = {
      type: 'run.completed',
      runId: 'run-1' as never,
      sessionId: 'session-1' as never,
      triggerType: 'new',
      timestamp: 1,
    }

    createAgentSessionMock.mockReturnValue({
      sessionId: 'session-1',
      abort: vi.fn(),
      async *query() {
        yield {
          type: 'message.delta',
          runId: 'run-1' as never,
          messageId: 'msg-1' as never,
          sequence: 0,
          channel: 'text',
          payload: { content: 'hello' },
          timestamp: 0,
        }
        yield completedEvent
      },
    })

    const { InProcessAgentRunner } = await import('../in-process-runner.js')
    const runner = new InProcessAgentRunner({
      agentId: 'reviewer',
      nativeAgentContext: createContext(),
    })

    await runner.connect()
    const events = await collectEvents(runner.query('hello'))

    expect(loadAgentContextForNameMock).toHaveBeenCalledWith('reviewer', expect.any(Object))
    expect(createAgentSessionMock).toHaveBeenCalled()
    expect(events).toHaveLength(2)
    expect(events[0]?.type).toBe('message.delta')
    expect(events[1]).toEqual(completedEvent)
  })

  it('stops yielding events after disconnect', async () => {
    let releaseNextEvent: (() => void) | null = null
    const abort = vi.fn()

    createAgentSessionMock.mockReturnValue({
      sessionId: 'session-1',
      abort,
      async *query() {
        yield {
          type: 'message.delta',
          runId: 'run-1' as never,
          messageId: 'msg-1' as never,
          sequence: 0,
          channel: 'text',
          payload: { content: 'first' },
          timestamp: 0,
        }
        await new Promise<void>((resolve) => {
          releaseNextEvent = resolve
        })
        yield {
          type: 'message.delta',
          runId: 'run-1' as never,
          messageId: 'msg-2' as never,
          sequence: 1,
          channel: 'text',
          payload: { content: 'second' },
          timestamp: 1,
        }
      },
    })

    const { InProcessAgentRunner } = await import('../in-process-runner.js')
    const runner = new InProcessAgentRunner({
      agentId: 'reviewer',
      nativeAgentContext: createContext(),
    })

    await runner.connect()
    const iterator = runner.query('hello')[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.value?.type).toBe('message.delta')

    const pendingNext = iterator.next()
    await runner.disconnect()
    ;(releaseNextEvent as (() => void) | null)?.()

    await expect(pendingNext).resolves.toEqual({ done: true, value: undefined })
    expect(abort).toHaveBeenCalledTimes(1)
  })

  it('deduplicates repeated run.completed events', async () => {
    createAgentSessionMock.mockReturnValue({
      sessionId: 'session-1',
      abort: vi.fn(),
      async *query() {
        const completed: RuntimeEvent = {
          type: 'run.completed',
          runId: 'run-1' as never,
          sessionId: 'session-1' as never,
          triggerType: 'new',
          timestamp: 1,
        }
        yield {
          type: 'run.failed',
          runId: 'run-1' as never,
          sessionId: 'session-1' as never,
          error: {
            code: 'runtime_error',
            message: 'boom',
          },
          timestamp: 0,
        }
        yield completed
        yield completed
      },
    })

    const { InProcessAgentRunner } = await import('../in-process-runner.js')
    const runner = new InProcessAgentRunner({
      agentId: 'reviewer',
      nativeAgentContext: createContext(),
    })

    await runner.connect()
    const events = await collectEvents(runner.query('hello'))

    expect(events.map((event) => event.type)).toEqual(['run.failed', 'run.completed'])
  })
})
