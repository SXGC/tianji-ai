import type { SessionNotification } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'

import { AcpNodeClient } from '../client-bridge.js'

describe('AcpNodeClient', () => {
  it('should be constructable', () => {
    const client = new AcpNodeClient()

    expect(client).toBeDefined()
  })

  it('should collect session updates', async () => {
    const client = new AcpNodeClient()
    const updates: Array<{ sessionId: string }> = []

    client.onSessionUpdate((update: SessionNotification) => {
      updates.push({ sessionId: update.sessionId })
    })

    await client.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
    })

    expect(updates).toHaveLength(1)
    expect(updates[0]!.sessionId).toBe('session-1')
  })

  it('should stop delivering updates after unsubscribe', async () => {
    const client = new AcpNodeClient()
    const updates: Array<{ sessionId: string }> = []

    const unsubscribe = client.onSessionUpdate((update: SessionNotification) => {
      updates.push({ sessionId: update.sessionId })
    })

    await client.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'before' },
      },
    })
    expect(updates).toHaveLength(1)

    unsubscribe()

    await client.sessionUpdate({
      sessionId: 'session-2',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'after' },
      },
    })
    expect(updates).toHaveLength(1)
  })

  it('should auto-approve permission requests', async () => {
    const client = new AcpNodeClient()

    const result = await client.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tc-1', title: 'read file', status: 'pending' },
      options: [
        { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
      ],
    })

    expect(result.outcome.outcome).toBe('selected')
    if (result.outcome.outcome === 'selected') {
      expect(result.outcome.optionId).toBe('allow')
    }
  })

  it('should fallback to first option when no allow option exists', async () => {
    const client = new AcpNodeClient()

    const result = await client.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tc-1', title: 'dangerous op', status: 'pending' },
      options: [
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
        { kind: 'deny_always', name: 'Deny', optionId: 'deny' },
      ],
    })

    expect(result.outcome.outcome).toBe('selected')
    if (result.outcome.outcome === 'selected') {
      expect(result.outcome.optionId).toBe('reject')
    }
  })
})
