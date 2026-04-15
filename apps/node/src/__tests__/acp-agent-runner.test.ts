import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentProcessManager } from '../acp/agent-process.js'
import type { AcpNodeClient } from '../acp/client-bridge.js'

// --- Mocks ---

const mockSpawn = vi.fn()
const mockKill = vi.fn()

vi.mock('../acp/agent-process.js', () => ({
  AgentProcessManager: vi.fn().mockImplementation(() => ({
    spawn: mockSpawn,
    kill: mockKill,
  })),
}))

const mockInitialize = vi.fn()
const mockNewSession = vi.fn()
const mockPrompt = vi.fn()

vi.mock('@agentclientprotocol/sdk', () => ({
  ClientSideConnection: vi.fn().mockImplementation(() => ({
    initialize: mockInitialize,
    newSession: mockNewSession,
    prompt: mockPrompt,
  })),
  ndJsonStream: vi.fn().mockReturnValue({}),
}))

const mockOnSessionUpdate = vi.fn()

vi.mock('../acp/client-bridge.js', () => ({
  AcpNodeClient: vi.fn().mockImplementation(() => ({
    onSessionUpdate: mockOnSessionUpdate,
  })),
}))

vi.mock('../acp/event-adapter.js', () => ({
  mapSessionUpdateToRuntimeEvent: vi.fn(),
}))

describe('AgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    mockSpawn.mockReturnValue({
      input: new ReadableStream(),
      output: new WritableStream(),
    })
    mockInitialize.mockResolvedValue({})
    mockNewSession.mockResolvedValue({ sessionId: 'session-123' })
    mockPrompt.mockResolvedValue({})
    mockKill.mockResolvedValue(undefined)
    mockOnSessionUpdate.mockReturnValue(() => {})
  })

  async function importRunner() {
    const mod = await import('../acp/agent-runner.js')
    return mod.AgentRunner
  }

  it('stores agentId from config', async () => {
    const AgentRunner = await importRunner()
    const runner = new AgentRunner({
      agentId: 'test-agent',
      command: 'tianji-agent',
    })

    expect(runner.agentId).toBe('test-agent')
  })

  describe('connect', () => {
    it('spawns process, creates connection, initializes and starts session', async () => {
      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        command: 'tianji-agent',
        args: ['--flag'],
        env: { KEY: 'val' },
      })

      await runner.connect()

      expect(mockSpawn).toHaveBeenCalled()
      expect(mockInitialize).toHaveBeenCalledWith({
        protocolVersion: 1,
        clientCapabilities: {},
      })
      expect(mockNewSession).toHaveBeenCalledWith({
        cwd: process.cwd(),
        mcpServers: [],
      })
    })

    it('passes custom command and args to AgentProcessManager', async () => {
      const { AgentProcessManager } = await import('../acp/agent-process.js')
      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'claude',
        command: 'claude',
        args: ['--acp'],
      })

      await runner.connect()

      expect(AgentProcessManager).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'claude',
          command: 'claude',
          args: ['--acp'],
        })
      )
    })
  })

  describe('query', () => {
    it('throws if not connected', async () => {
      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      const iter = runner.query('hello')
      await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(
        'Not connected. Call connect() first.'
      )
    })

    it('yields events from buffer and ends with RunCompleted', async () => {
      const { mapSessionUpdateToRuntimeEvent } = await import('../acp/event-adapter.js')
      const mapFn = mapSessionUpdateToRuntimeEvent as ReturnType<typeof vi.fn>

      // 模拟 onSessionUpdate: 捕获回调并立即触发两个事件
      let capturedCallback: ((update: unknown) => void) | null = null
      mockOnSessionUpdate.mockImplementation((cb: (update: unknown) => void) => {
        capturedCallback = cb
        return () => {}
      })

      // prompt 立即 resolve，但先触发 onSessionUpdate 回调
      mockPrompt.mockImplementation(() => {
        if (capturedCallback) {
          capturedCallback({
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
          })
          capturedCallback({
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'thinking' },
            },
          })
        }
        return Promise.resolve({})
      })

      mapFn.mockImplementation(
        (notification: { update: { sessionUpdate: string } }, runId: string) => {
          const now = Date.now()
          if (notification.update.sessionUpdate === 'agent_message_chunk') {
            const event = {
              type: 'MessageDelta',
              runId,
              messageId: 'msg1',
              sequence: 0,
              channel: 'text',
              payload: { content: 'hi' },
              timestamp: now,
            }
            return {
              eventId: `test_msg_${now}`,
              type: 'MessageDelta',
              occurredAt: new Date(now).toISOString(),
              correlationId: String(runId),
              causationId: null,
              sequence: 0,
              aggregateType: 'Run',
              aggregateId: String(runId),
              source: { processKind: 'node', processId: 'test' },
              payload: event,
            }
          }
          if (notification.update.sessionUpdate === 'agent_thought_chunk') {
            const event = {
              type: 'MessageDelta',
              runId,
              messageId: 'msg2',
              sequence: 1,
              channel: 'thinking',
              payload: { content: 'thinking' },
              timestamp: now,
            }
            return {
              eventId: `test_thought_${now}`,
              type: 'MessageDelta',
              occurredAt: new Date(now).toISOString(),
              correlationId: String(runId),
              causationId: null,
              sequence: 0,
              aggregateType: 'Run',
              aggregateId: String(runId),
              source: { processKind: 'node', processId: 'test' },
              payload: event,
            }
          }
          return null
        }
      )

      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      await runner.connect()

      const events = []
      for await (const event of runner.query('hello')) {
        events.push(event)
      }

      // 应包含两个 MessageDelta 和一个 RunCompleted
      expect(events.length).toBe(3)
      expect(events[0]!.type).toBe('MessageDelta')
      expect(events[1]!.type).toBe('MessageDelta')
      expect(events[2]!.type).toBe('RunCompleted')
    })

    it('yields RunCompleted even when no events are produced', async () => {
      const { mapSessionUpdateToRuntimeEvent } = await import('../acp/event-adapter.js')
      const mapFn = mapSessionUpdateToRuntimeEvent as ReturnType<typeof vi.fn>
      mapFn.mockReturnValue(null)

      mockOnSessionUpdate.mockReturnValue(() => {})
      mockPrompt.mockResolvedValue({})

      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      await runner.connect()

      const events = []
      for await (const event of runner.query('hello')) {
        events.push(event)
      }

      expect(events.length).toBe(1)
      expect(events[0]!.type).toBe('RunCompleted')
    })

    it('unsubscribes from session updates after query completes', async () => {
      const unsubscribe = vi.fn()
      mockOnSessionUpdate.mockReturnValue(unsubscribe)
      mockPrompt.mockResolvedValue({})

      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      await runner.connect()

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _event of runner.query('hello')) {
        // consume
      }

      expect(unsubscribe).toHaveBeenCalled()
    })

    it('propagates prompt rejection as a thrown error and logs it', async () => {
      const unsubscribe = vi.fn()
      mockOnSessionUpdate.mockReturnValue(unsubscribe)
      const upstreamError = new Error(
        '500 empty_stream: upstream stream closed before first payload'
      )
      mockPrompt.mockRejectedValue(upstreamError)

      const logError = vi.fn().mockResolvedValue(undefined)
      const logger = {
        logInfo: vi.fn().mockResolvedValue(undefined),
        logDebug: vi.fn().mockResolvedValue(undefined),
        logError,
        logWarn: vi.fn().mockResolvedValue(undefined),
      }

      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        command: 'tianji-agent',
        logger: logger as unknown as ConstructorParameters<typeof AgentRunner>[0]['logger'],
      })

      await runner.connect()

      const consume = async () => {
        const events = []
        for await (const event of runner.query('hello')) {
          events.push(event)
        }
        return events
      }

      await expect(consume()).rejects.toThrow(upstreamError)
      expect(unsubscribe).toHaveBeenCalled()
      expect(logError).toHaveBeenCalledWith(
        ['acp', 'runner'],
        'Agent prompt failed',
        expect.objectContaining({
          agentId: 'test-agent',
          errorMessage: upstreamError.message,
        })
      )
    })
  })

  describe('disconnect', () => {
    it('kills process and clears state', async () => {
      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      await runner.connect()
      await runner.disconnect()

      expect(mockKill).toHaveBeenCalled()
    })

    it('handles disconnect when not connected', async () => {
      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      await expect(runner.disconnect()).resolves.toBeUndefined()
    })
  })
})
