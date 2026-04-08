import type { SessionNotification } from '@agentclientprotocol/sdk'
import { createRunId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { mapSessionUpdateToRuntimeEvent } from '../event-adapter.js'

describe('mapSessionUpdateToRuntimeEvent', () => {
  const runId = createRunId('run-001')
  const sessionId = 'session-001'

  it('should map agent_message_chunk to message.delta (text)', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)

    expect(result).not.toBeNull()
    expect(result?.type).toBe('message.delta')
    if (result?.type === 'message.delta') {
      expect(result.channel).toBe('text')
      expect(result.payload.content).toBe('Hello')
    }
  })

  it('should map agent_thought_chunk to message.delta (thinking)', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Thinking...' },
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)

    expect(result).not.toBeNull()
    if (result?.type === 'message.delta') {
      expect(result.channel).toBe('thinking')
    }
  })

  it('should map tool_call to tool.started', () => {
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
    expect(result?.type).toBe('tool.started')
  })

  it('should map tool_call_update with status completed to tool.completed', () => {
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
    expect(result?.type).toBe('tool.completed')
    if (result?.type === 'tool.completed') {
      expect(result.toolCallId).toBe('tc-2')
      expect(result.invocation.toolName).toBe('write_file')
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
    if (result?.type === 'tool.started') {
      expect(result.invocation.toolName).toBe('unknown')
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
    if (result?.type === 'tool.completed') {
      expect(result.invocation.toolName).toBe('unknown')
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
    if (result?.type === 'message.delta') {
      expect(result.payload.content).toBe('')
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
