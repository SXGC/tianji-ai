import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { createRunId, createSessionId } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'
import type { AgentExecutorFactory, OrchestrationGraph } from '../../orchestration/index.js'

import { TianjiAcpAgent } from '../agent-bridge.js'

/** 最小化 stub，仅满足 TianjiAcpAgent 构造签名所需 */
const stubDefaultGraph = {} as OrchestrationGraph
const stubExecutorFactory = (() => {
  throw new Error('not used in unit tests')
}) as unknown as AgentExecutorFactory

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

function createMockSessionFactory() {
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

  return vi.fn().mockReturnValue({
    sessionId: createSessionId('session-test'),
    abort: vi.fn(),
    close: vi.fn(),
    async *queryWithGraph(_graph: OrchestrationGraph) {
      for (const event of events) {
        yield event
      }
    },
  })
}

describe('TianjiAcpAgent', () => {
  it('should return protocol version on initialize', async () => {
    const conn = createMockConnection()
    const factory = createMockSessionFactory()
    const agent = new TianjiAcpAgent(conn, factory, stubDefaultGraph, stubExecutorFactory)

    const result = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })

    expect(result.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('should create a new session via newSession', async () => {
    const conn = createMockConnection()
    const factory = createMockSessionFactory()
    const agent = new TianjiAcpAgent(conn, factory, stubDefaultGraph, stubExecutorFactory)

    const result = await agent.newSession({ cwd: '/tmp', mcpServers: [] })
    expect(result.sessionId).toBeDefined()
    expect(typeof result.sessionId).toBe('string')
    expect(factory).toHaveBeenCalled()
  })

  it('should stream events on prompt and return end_turn', async () => {
    const conn = createMockConnection()
    const factory = createMockSessionFactory()
    const agent = new TianjiAcpAgent(conn, factory, stubDefaultGraph, stubExecutorFactory)

    await agent.newSession({ cwd: '/tmp', mcpServers: [] })

    const result = await agent.prompt({
      sessionId: 'session-test',
      prompt: [{ type: 'text', text: 'hello' }],
    })

    expect(result.stopReason).toBe('end_turn')
    expect(conn.sessionUpdate).toHaveBeenCalled()
  })

  it('should reject prompt when sessionId does not match current session', async () => {
    const conn = createMockConnection()
    const factory = createMockSessionFactory()
    const agent = new TianjiAcpAgent(conn, factory, stubDefaultGraph, stubExecutorFactory)

    await agent.newSession({ cwd: '/tmp', mcpServers: [] })

    await expect(
      agent.prompt({
        sessionId: 'different-session',
        prompt: [{ type: 'text', text: 'hello' }],
      })
    ).rejects.toThrow('Session not found: different-session')
  })

  it('should handle cancel without error', async () => {
    const conn = createMockConnection()
    const factory = createMockSessionFactory()
    const agent = new TianjiAcpAgent(conn, factory, stubDefaultGraph, stubExecutorFactory)

    await expect(agent.cancel({ sessionId: 'session-test' })).resolves.toBeUndefined()
  })

  it('should handle authenticate', async () => {
    const conn = createMockConnection()
    const factory = createMockSessionFactory()
    const agent = new TianjiAcpAgent(conn, factory, stubDefaultGraph, stubExecutorFactory)

    const result = await agent.authenticate({ methodId: 'none' })
    expect(result).toEqual({})
  })
})
