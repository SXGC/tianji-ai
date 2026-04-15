import type { SessionNotification } from '@agentclientprotocol/sdk'
import type {
  MessageDeltaEvent,
  RunCompletedEvent,
  ToolCompletedEvent,
  ToolStartedEvent,
} from '@tianji/shared'
import { createRunId, createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { mapRuntimeEventToSessionUpdate } from '../event-mapper.js'

describe('mapRuntimeEventToSessionUpdate', () => {
  const sessionId = 'session-001'
  const runId = createRunId('run-001')

  it('should map MessageDelta (text channel) to agent_message_chunk', () => {
    const event: MessageDeltaEvent = {
      type: 'MessageDelta',
      runId,
      messageId: 'msg-1',
      sequence: 0,
      channel: 'text',
      payload: { content: 'Hello world' },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(sessionId, event)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe(sessionId)
    expect(result!.update.sessionUpdate).toBe('agent_message_chunk')
  })

  it('should map MessageDelta (thinking channel) to agent_thought_chunk', () => {
    const event: MessageDeltaEvent = {
      type: 'MessageDelta',
      runId,
      messageId: 'msg-1',
      sequence: 0,
      channel: 'thinking',
      payload: { content: 'Let me think...' },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(sessionId, event)
    expect(result).not.toBeNull()
    expect(result!.update.sessionUpdate).toBe('agent_thought_chunk')
  })

  it('should map ToolStarted to tool_call with pending status', () => {
    const event: ToolStartedEvent = {
      type: 'ToolStarted',
      runId,
      toolCallId: 'tc-1',
      invocation: { toolCallId: 'tc-1', toolName: 'read_file', args: { path: '/a.ts' } },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(sessionId, event)
    expect(result).not.toBeNull()
    expect(result!.update.sessionUpdate).toBe('tool_call')
    if (result!.update.sessionUpdate === 'tool_call') {
      expect(result!.update.toolCallId).toBe('tc-1')
      expect(result!.update.status).toBe('pending')
    }
  })

  it('should map ToolCompleted to tool_call_update with completed status', () => {
    const event: ToolCompletedEvent = {
      type: 'ToolCompleted',
      runId,
      toolCallId: 'tc-1',
      invocation: { toolCallId: 'tc-1', toolName: 'readFile', args: {} },
      result: { toolCallId: 'tc-1', result: { output: 'file contents' } },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(sessionId, event)
    expect(result).not.toBeNull()
    expect(result!.update.sessionUpdate).toBe('tool_call_update')
  })

  it('should return null for run lifecycle events (not mapped to session update)', () => {
    const event: RunCompletedEvent = {
      type: 'RunCompleted',
      runId,
      sessionId: createSessionId('s'),
      triggerType: 'new',
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(sessionId, event)
    expect(result).toBeNull()
  })

  it('should return a valid SessionNotification shape', () => {
    const event: MessageDeltaEvent = {
      type: 'MessageDelta',
      runId,
      messageId: 'msg-2',
      sequence: 1,
      channel: 'text',
      payload: { content: 'ok' },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(sessionId, event)
    const notification: SessionNotification | null = result

    expect(notification?.sessionId).toBe(sessionId)
  })
})
