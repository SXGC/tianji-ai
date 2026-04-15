import type {
  MessageCompletedEvent,
  MessageDeltaEvent,
  MessageStartedEvent,
  RunCancelledEvent,
  RunCompletedEvent,
  RunFailedEvent,
  ToolCompletedEvent,
  ToolFailedEvent,
  ToolStartedEvent,
} from '@tianji/shared'
import { createRunId, createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { mapRuntimeEventToSessionUpdate } from '../acp/event-mapper.js'

const SESSION_ID = 'test-session-1'
const runId = createRunId('run-1')
const sessionId = createSessionId('sid')

describe('mapRuntimeEventToSessionUpdate', () => {
  it('maps MessageDelta with text channel to agent_message_chunk', () => {
    const event: MessageDeltaEvent = {
      type: 'MessageDelta',
      runId,
      messageId: 'msg-1',
      sequence: 0,
      channel: 'text',
      payload: { content: 'hello' },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toEqual({
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
    })
  })

  it('maps MessageDelta with thinking channel to agent_thought_chunk', () => {
    const event: MessageDeltaEvent = {
      type: 'MessageDelta',
      runId,
      messageId: 'msg-1',
      sequence: 0,
      channel: 'thinking',
      payload: { content: 'reasoning...' },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toEqual({
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'reasoning...' },
      },
    })
  })

  it('maps ToolStarted with read-like tool to kind "read"', () => {
    const event: ToolStartedEvent = {
      type: 'ToolStarted',
      runId,
      toolCallId: 'tc-1',
      invocation: { toolName: 'fileRead', args: { path: '/tmp' } },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        kind: 'read',
        status: 'pending',
      },
    })
  })

  it('maps ToolStarted with edit-like tool to kind "edit"', () => {
    const event: ToolStartedEvent = {
      type: 'ToolStarted',
      runId,
      toolCallId: 'tc-2',
      invocation: { toolName: 'fileEdit', args: {} },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'edit' },
    })
  })

  it('maps ToolStarted with write-like tool to kind "edit"', () => {
    const event: ToolStartedEvent = {
      type: 'ToolStarted',
      runId,
      toolCallId: 'tc-2b',
      invocation: { toolName: 'filewrite', args: {} },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'edit' },
    })
  })

  it('maps ToolStarted with exec-like tool to kind "execute"', () => {
    const event: ToolStartedEvent = {
      type: 'ToolStarted',
      runId,
      toolCallId: 'tc-3',
      invocation: { toolName: 'bash', args: { command: 'ls' } },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'execute' },
    })
  })

  it('maps ToolStarted with shell-like tool to kind "execute"', () => {
    const event: ToolStartedEvent = {
      type: 'ToolStarted',
      runId,
      toolCallId: 'tc-3b',
      invocation: { toolName: 'shell_run', args: {} },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'execute' },
    })
  })

  it('maps ToolStarted with search-like tool to kind "search"', () => {
    const event: ToolStartedEvent = {
      type: 'ToolStarted',
      runId,
      toolCallId: 'tc-4',
      invocation: { toolName: 'grep', args: {} },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'search' },
    })
  })

  it('maps ToolStarted with find-like tool to kind "search"', () => {
    const event: ToolStartedEvent = {
      type: 'ToolStarted',
      runId,
      toolCallId: 'tc-4b',
      invocation: { toolName: 'find_files', args: {} },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'search' },
    })
  })

  it('maps ToolStarted with unknown tool to kind "other"', () => {
    const event: ToolStartedEvent = {
      type: 'ToolStarted',
      runId,
      toolCallId: 'tc-5',
      invocation: { toolName: 'customTool', args: {} },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'other' },
    })
  })

  it('maps ToolCompleted', () => {
    const event: ToolCompletedEvent = {
      type: 'ToolCompleted',
      runId,
      toolCallId: 'tc-1',
      invocation: { toolCallId: 'tc-1', toolName: 'readFile', args: {} },
      result: { toolCallId: 'tc-1', result: { content: 'done' } },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toEqual({
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
      },
    })
  })

  it('maps ToolFailed', () => {
    const event: ToolFailedEvent = {
      type: 'ToolFailed',
      runId,
      toolCallId: 'tc-1',
      invocation: { toolName: 'bash', args: {} },
      error: { code: 'TOOL_ERROR', message: 'fail' } as never,
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toEqual({
      sessionId: SESSION_ID,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'failed',
      },
    })
  })

  it('returns null for MessageStarted', () => {
    const event: MessageStartedEvent = {
      type: 'MessageStarted',
      runId,
      messageId: 'msg-1',
      message: {} as never,
      timestamp: Date.now(),
    }
    expect(mapRuntimeEventToSessionUpdate(SESSION_ID, event)).toBeNull()
  })

  it('returns null for MessageCompleted', () => {
    const event: MessageCompletedEvent = {
      type: 'MessageCompleted',
      runId,
      messageId: 'msg-1',
      message: {} as never,
      timestamp: Date.now(),
    }
    expect(mapRuntimeEventToSessionUpdate(SESSION_ID, event)).toBeNull()
  })

  it('returns null for RunCompleted', () => {
    const event: RunCompletedEvent = {
      type: 'RunCompleted',
      runId,
      sessionId,
      triggerType: 'new',
      timestamp: Date.now(),
    }
    expect(mapRuntimeEventToSessionUpdate(SESSION_ID, event)).toBeNull()
  })

  it('returns null for RunFailed', () => {
    const event: RunFailedEvent = {
      type: 'RunFailed',
      runId,
      sessionId,
      triggerType: 'new',
      error: { code: 'ERR', message: 'fail' } as never,
      timestamp: Date.now(),
    }
    expect(mapRuntimeEventToSessionUpdate(SESSION_ID, event)).toBeNull()
  })

  it('returns null for RunCancelled', () => {
    const event: RunCancelledEvent = {
      type: 'RunCancelled',
      runId,
      sessionId,
      triggerType: 'new',
      reason: 'abort',
      timestamp: Date.now(),
    }
    expect(mapRuntimeEventToSessionUpdate(SESSION_ID, event)).toBeNull()
  })
})
