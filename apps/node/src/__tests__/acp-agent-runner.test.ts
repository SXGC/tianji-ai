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
      entryPath: '/path/to/acp-entry.js',
    })

    expect(runner.agentId).toBe('test-agent')
  })

  describe('connect', () => {
    it('spawns process, creates connection, initializes and starts session', async () => {
      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        entryPath: '/path/to/acp-entry.js',
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
  })

  describe('chat', () => {
    it('throws if not connected', async () => {
      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        entryPath: '/path/to/acp-entry.js',
      })

      const iter = runner.chat('hello')
      await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(
        'Not connected. Call connect() first.'
      )
    })

    it('yields events from buffer and ends with run.completed', async () => {
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
          if (notification.update.sessionUpdate === 'agent_message_chunk') {
            return {
              type: 'message.delta',
              runId,
              messageId: 'msg1',
              sequence: 0,
              channel: 'text',
              payload: { content: 'hi' },
              timestamp: Date.now(),
            }
          }
          if (notification.update.sessionUpdate === 'agent_thought_chunk') {
            return {
              type: 'message.delta',
              runId,
              messageId: 'msg2',
              sequence: 1,
              channel: 'thinking',
              payload: { content: 'thinking' },
              timestamp: Date.now(),
            }
          }
          return null
        }
      )

      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        entryPath: '/path/to/acp-entry.js',
      })

      await runner.connect()

      const events = []
      for await (const event of runner.chat('hello')) {
        events.push(event)
      }

      // 应包含两个 message.delta 和一个 run.completed
      expect(events.length).toBe(3)
      expect(events[0]!.type).toBe('message.delta')
      expect(events[1]!.type).toBe('message.delta')
      expect(events[2]!.type).toBe('run.completed')
    })

    it('yields run.completed even when no events are produced', async () => {
      const { mapSessionUpdateToRuntimeEvent } = await import('../acp/event-adapter.js')
      const mapFn = mapSessionUpdateToRuntimeEvent as ReturnType<typeof vi.fn>
      mapFn.mockReturnValue(null)

      mockOnSessionUpdate.mockReturnValue(() => {})
      mockPrompt.mockResolvedValue({})

      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        entryPath: '/path/to/acp-entry.js',
      })

      await runner.connect()

      const events = []
      for await (const event of runner.chat('hello')) {
        events.push(event)
      }

      expect(events.length).toBe(1)
      expect(events[0]!.type).toBe('run.completed')
    })

    it('unsubscribes from session updates after chat completes', async () => {
      const unsubscribe = vi.fn()
      mockOnSessionUpdate.mockReturnValue(unsubscribe)
      mockPrompt.mockResolvedValue({})

      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        entryPath: '/path/to/acp-entry.js',
      })

      await runner.connect()

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _event of runner.chat('hello')) {
        // consume
      }

      expect(unsubscribe).toHaveBeenCalled()
    })

    it('unsubscribes even when prompt rejects', async () => {
      const unsubscribe = vi.fn()
      mockOnSessionUpdate.mockReturnValue(unsubscribe)
      mockPrompt.mockRejectedValue(new Error('prompt failed'))

      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        entryPath: '/path/to/acp-entry.js',
      })

      await runner.connect()

      const events = []
      for await (const event of runner.chat('hello')) {
        events.push(event)
      }

      // prompt rejection 被静默处理（设置 promptDone=true），仍应产生 run.completed
      expect(events[events.length - 1]!.type).toBe('run.completed')
      expect(unsubscribe).toHaveBeenCalled()
    })
  })

  describe('disconnect', () => {
    it('kills process and clears state', async () => {
      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        entryPath: '/path/to/acp-entry.js',
      })

      await runner.connect()
      await runner.disconnect()

      expect(mockKill).toHaveBeenCalled()
    })

    it('handles disconnect when not connected', async () => {
      const AgentRunner = await importRunner()
      const runner = new AgentRunner({
        agentId: 'test-agent',
        entryPath: '/path/to/acp-entry.js',
      })

      await expect(runner.disconnect()).resolves.toBeUndefined()
    })
  })
})
