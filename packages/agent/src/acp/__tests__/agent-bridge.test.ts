import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { ObserverLogger } from '@tianji/observer'
import { createRunId, createSessionId } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import { TianjiAcpAgent } from '../agent-bridge.js'

function createMockConnection(): AgentSideConnection {
  return {
    sessionUpdate: vi.fn().mockResolvedValue(undefined),
    requestPermission: vi.fn(),
    readTextFile: vi.fn(),
    writeTextFile: vi.fn(),
    createTerminal: vi.fn(),
    extMethod: vi.fn(),
    extNotification: vi.fn(),
    signal: new AbortController().signal,
    closed: new Promise(() => {}),
  } as unknown as AgentSideConnection
}

function createMockEntry() {
  const events = [
    {
      type: 'MessageDelta' as const,
      runId: createRunId('run-1'),
      messageId: 'msg-1',
      sequence: 0,
      channel: 'text' as const,
      payload: { content: 'Hello' },
      timestamp: Date.now(),
    },
    {
      type: 'RunCompleted' as const,
      runId: createRunId('run-1'),
      sessionId: createSessionId('s'),
      triggerType: 'new' as const,
      timestamp: Date.now(),
    },
  ]

  return {
    run: vi.fn(async () => ({
      sessionId: createSessionId('session-test'),
      runId: createRunId('run-1'),
      events: (async function* () {
        for (const event of events) {
          yield event
        }
      })(),
    })),
    resume: vi.fn(),
    cancel: vi.fn(),
    stream: vi.fn(),
  }
}

function createSessionIdSpy() {
  return vi.spyOn(Date, 'now').mockReturnValue(123)
}

describe('TianjiAcpAgent', () => {
  it('should return protocol version on initialize', async () => {
    const conn = createMockConnection()
    const entry = createMockEntry()
    const agent = new TianjiAcpAgent(conn, entry)

    const result = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })

    expect(result.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('should create a new session via newSession', async () => {
    const conn = createMockConnection()
    const entry = createMockEntry()
    const nowSpy = createSessionIdSpy()
    const agent = new TianjiAcpAgent(conn, entry)

    const result = await agent.newSession({ cwd: '/tmp', mcpServers: [] })
    expect(result.sessionId).toBe('session_123')
    nowSpy.mockRestore()
  })

  it('should stream events on prompt and return end_turn', async () => {
    const conn = createMockConnection()
    const entry = createMockEntry()
    const nowSpy = createSessionIdSpy()
    const agent = new TianjiAcpAgent(conn, entry)

    await agent.newSession({ cwd: '/tmp', mcpServers: [] })

    const result = await agent.prompt({
      sessionId: 'session_123',
      prompt: [{ type: 'text', text: 'hello' }],
    })

    expect(result.stopReason).toBe('end_turn')
    expect(entry.run).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'acp', input: 'hello', sessionId: 'session_123' })
    )
    expect(conn.sessionUpdate).toHaveBeenCalled()
    nowSpy.mockRestore()
  })

  it('should reject prompt when sessionId does not match current session', async () => {
    const conn = createMockConnection()
    const entry = createMockEntry()
    const nowSpy = createSessionIdSpy()
    const agent = new TianjiAcpAgent(conn, entry)

    await agent.newSession({ cwd: '/tmp', mcpServers: [] })

    await expect(
      agent.prompt({
        sessionId: 'different-session',
        prompt: [{ type: 'text', text: 'hello' }],
      })
    ).rejects.toThrow('Session not found: different-session')
    nowSpy.mockRestore()
  })

  it('should handle cancel without error', async () => {
    const conn = createMockConnection()
    const entry = createMockEntry()
    const agent = new TianjiAcpAgent(conn, entry)

    await expect(agent.cancel({ sessionId: 'session-test' })).resolves.toBeUndefined()
  })

  it('should handle authenticate', async () => {
    const conn = createMockConnection()
    const entry = createMockEntry()
    const agent = new TianjiAcpAgent(conn, entry)

    const result = await agent.authenticate({ methodId: 'none' })
    expect(result).toEqual({})
  })
})

describe('TianjiAcpAgent logger injection', () => {
  function createMockLogger(): ObserverLogger {
    return {
      log: vi.fn().mockResolvedValue(undefined),
      trace: vi.fn().mockResolvedValue(undefined),
      debug: vi.fn().mockResolvedValue(undefined),
      info: vi.fn().mockResolvedValue(undefined),
      warn: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
      fatal: vi.fn().mockResolvedValue(undefined),
      child: vi.fn(),
    } as unknown as ObserverLogger
  }

  it('routes cancel to logger.debug when logger is provided', async () => {
    const logger = createMockLogger()
    const conn = createMockConnection()
    const entry = createMockEntry()

    const agent = new TianjiAcpAgent(conn, entry, { logger })
    await agent.cancel({ sessionId: 'unused' } as never)

    expect(logger.debug).toHaveBeenCalledWith(['acp', 'bridge'], 'received cancel request')
  })

  it('routes initialize to logger.debug when logger is provided', async () => {
    const logger = createMockLogger()
    const conn = createMockConnection()
    const entry = createMockEntry()

    const agent = new TianjiAcpAgent(conn, entry, { logger })
    await agent.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })

    expect(logger.debug).toHaveBeenCalledWith(['acp', 'bridge'], 'received initialize request')
  })

  it('routes newSession to logger.info when logger is provided', async () => {
    const logger = createMockLogger()
    const conn = createMockConnection()
    const entry = createMockEntry()
    vi.spyOn(Date, 'now').mockReturnValue(999)

    const agent = new TianjiAcpAgent(conn, entry, { logger })
    await agent.newSession({ cwd: '/tmp', mcpServers: [] })

    expect(logger.info).toHaveBeenCalledWith(
      ['acp', 'bridge'],
      'new session created',
      expect.objectContaining({ sessionId: 'session_999' })
    )
    vi.restoreAllMocks()
  })

  it('still works without logger (backward compat)', async () => {
    const conn = createMockConnection()
    const entry = createMockEntry()

    // 不传 logger，不应该抛错
    const agent = new TianjiAcpAgent(conn, entry)
    await expect(agent.cancel({ sessionId: 'x' } as never)).resolves.toBeUndefined()
  })
})
