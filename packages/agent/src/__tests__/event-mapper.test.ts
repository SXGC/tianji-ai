import type { RuntimeEvent } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { mapRuntimeEventToSessionUpdate } from '../acp/event-mapper.js'

const SESSION_ID = 'test-session-1'

describe('mapRuntimeEventToSessionUpdate', () => {
  it('maps message.delta with text channel to agent_message_chunk', () => {
    const event: RuntimeEvent = {
      type: 'message.delta',
      runId: 'run-1' as never,
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

  it('maps message.delta with thinking channel to agent_thought_chunk', () => {
    const event: RuntimeEvent = {
      type: 'message.delta',
      runId: 'run-1' as never,
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

  it('maps tool.started with read-like tool to kind "read"', () => {
    const event: RuntimeEvent = {
      type: 'tool.started',
      runId: 'run-1' as never,
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

  it('maps tool.started with edit-like tool to kind "edit"', () => {
    const event: RuntimeEvent = {
      type: 'tool.started',
      runId: 'run-1' as never,
      toolCallId: 'tc-2',
      invocation: { toolName: 'fileEdit', args: {} },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'edit' },
    })
  })

  it('maps tool.started with write-like tool to kind "edit"', () => {
    const event: RuntimeEvent = {
      type: 'tool.started',
      runId: 'run-1' as never,
      toolCallId: 'tc-2b',
      invocation: { toolName: 'filewrite', args: {} },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'edit' },
    })
  })

  it('maps tool.started with exec-like tool to kind "execute"', () => {
    const event: RuntimeEvent = {
      type: 'tool.started',
      runId: 'run-1' as never,
      toolCallId: 'tc-3',
      invocation: { toolName: 'bash', args: { command: 'ls' } },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'execute' },
    })
  })

  it('maps tool.started with shell-like tool to kind "execute"', () => {
    const event: RuntimeEvent = {
      type: 'tool.started',
      runId: 'run-1' as never,
      toolCallId: 'tc-3b',
      invocation: { toolName: 'shell_run', args: {} },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'execute' },
    })
  })

  it('maps tool.started with search-like tool to kind "search"', () => {
    const event: RuntimeEvent = {
      type: 'tool.started',
      runId: 'run-1' as never,
      toolCallId: 'tc-4',
      invocation: { toolName: 'grep', args: {} },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'search' },
    })
  })

  it('maps tool.started with find-like tool to kind "search"', () => {
    const event: RuntimeEvent = {
      type: 'tool.started',
      runId: 'run-1' as never,
      toolCallId: 'tc-4b',
      invocation: { toolName: 'find_files', args: {} },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'search' },
    })
  })

  it('maps tool.started with unknown tool to kind "other"', () => {
    const event: RuntimeEvent = {
      type: 'tool.started',
      runId: 'run-1' as never,
      toolCallId: 'tc-5',
      invocation: { toolName: 'customTool', args: {} },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(SESSION_ID, event)

    expect(result).toMatchObject({
      update: { kind: 'other' },
    })
  })

  it('maps tool.completed', () => {
    const event: RuntimeEvent = {
      type: 'tool.completed',
      runId: 'run-1' as never,
      toolCallId: 'tc-1',
      invocation: { toolCallId: 'tc-1', toolName: 'readFile', args: {} },
      result: { content: 'done' } as never,
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

  it('maps tool.failed', () => {
    const event: RuntimeEvent = {
      type: 'tool.failed',
      runId: 'run-1' as never,
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

  it.each([
    'message.started',
    'message.completed',
    'run.started',
    'run.completed',
    'run.failed',
    'run.cancelled',
  ] as const)('returns null for %s', (eventType) => {
    // Build a minimal event matching the type discriminant
    const base = { runId: 'run-1', timestamp: Date.now() }
    let event: RuntimeEvent

    switch (eventType) {
      case 'message.started':
      case 'message.completed':
        event = {
          type: eventType,
          ...base,
          messageId: 'msg-1',
          message: {} as never,
        } as RuntimeEvent
        break
      case 'run.failed':
        event = {
          type: eventType,
          ...base,
          sessionId: 'sid' as never,
          triggerType: 'new' as never,
          error: { code: 'ERR', message: 'fail' } as never,
        } as RuntimeEvent
        break
      default:
        event = {
          type: eventType,
          ...base,
          sessionId: 'sid' as never,
          triggerType: 'new' as never,
        } as RuntimeEvent
    }

    expect(mapRuntimeEventToSessionUpdate(SESSION_ID, event)).toBeNull()
  })
})
