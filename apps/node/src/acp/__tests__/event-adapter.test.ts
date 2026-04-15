import type { SessionNotification } from '@agentclientprotocol/sdk'
import { createRunId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { mapSessionUpdateToRuntimeEvent } from '../event-adapter.js'

describe('mapSessionUpdateToRuntimeEvent', () => {
  const runId = createRunId('run-001')
  const sessionId = 'session-001'

  it('should map agent_message_chunk to envelope with MessageDelta payload (text)', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)

    expect(result).not.toBeNull()
    expect(result?.type).toBe('MessageDelta')
    expect(result?.aggregateType).toBe('Run')
    const payload = result?.payload
    if (payload?.type === 'MessageDelta') {
      expect(payload.channel).toBe('text')
      expect(payload.payload.content).toBe('Hello')
    }
  })

  it('should map agent_thought_chunk to envelope with MessageDelta payload (thinking)', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Thinking...' },
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)

    expect(result).not.toBeNull()
    const payload = result?.payload
    if (payload?.type === 'MessageDelta') {
      expect(payload.channel).toBe('thinking')
    }
  })

  it('should map tool_call to envelope with ToolStarted payload', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'read_file',
        kind: 'read',
        status: 'pending',
        rawInput: { path: '/a.ts' },
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)

    expect(result).not.toBeNull()
    expect(result?.type).toBe('ToolStarted')
  })

  it('should map tool_call_update completed to envelope with ToolCompleted payload', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-2',
        title: 'write_file',
        kind: 'write',
        status: 'completed',
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)

    expect(result).not.toBeNull()
    expect(result?.type).toBe('ToolCompleted')
    const payload = result?.payload
    if (payload?.type === 'ToolCompleted') {
      expect(payload.toolCallId).toBe('tc-2')
      expect(payload.invocation.toolName).toBe('write_file')
    }
  })

  it('should return null for tool_call_update with non-completed status', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-3',
        title: 'read_file',
        kind: 'read',
        status: 'running',
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)

    expect(result).toBeNull()
  })

  it('should use "unknown" when tool_call title is undefined', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-4',
        kind: 'read',
        status: 'pending',
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)

    expect(result).not.toBeNull()
    const payload = result?.payload
    if (payload?.type === 'ToolStarted') {
      expect(payload.invocation.toolName).toBe('unknown')
    }
  })

  it('should use "unknown" when tool_call_update completed title is undefined', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-5',
        kind: 'read',
        status: 'completed',
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)

    expect(result).not.toBeNull()
    const payload = result?.payload
    if (payload?.type === 'ToolCompleted') {
      expect(payload.invocation.toolName).toBe('unknown')
    }
  })

  it('should extract empty string for non-text content type', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', url: 'http://example.com/img.png' } as never,
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)

    expect(result).not.toBeNull()
    const payload = result?.payload
    if (payload?.type === 'MessageDelta') {
      expect(payload.payload.content).toBe('')
    }
  })

  it('should return null for unmapped update types', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'usage_update',
        size: 100,
        used: 50,
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)

    expect(result).toBeNull()
  })
})
