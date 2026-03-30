import { describe, expect, it } from 'vitest'
import { ProviderError, ToolError } from '../errors.js'
import type {
  MessageCompletedEvent,
  MessageDeltaChannel,
  MessageDeltaEvent,
  MessageDeltaPayload,
  MessageStartedEvent,
  RunCancelledEvent,
  RunCompletedEvent,
  RunFailedEvent,
  RunStartedEvent,
  RuntimeEvent,
  RuntimeEventType,
  ToolCompletedEvent,
  ToolFailedEvent,
  ToolStartedEvent,
} from '../events.js'
import { createRunId, createSessionId } from '../identifiers.js'

describe('events types', () => {
  const sessionId = createSessionId('session_123')
  const runId = createRunId('run_456')

  describe('RuntimeEventType', () => {
    it('should define all run event types', () => {
      const runTypes: RuntimeEventType[] = [
        'run.started',
        'run.completed',
        'run.failed',
        'run.cancelled',
      ]
      expect(runTypes).toHaveLength(4)
      expect(runTypes).toContain('run.started')
      expect(runTypes).toContain('run.completed')
      expect(runTypes).toContain('run.failed')
      expect(runTypes).toContain('run.cancelled')
    })

    it('should define all message event types', () => {
      const messageTypes: RuntimeEventType[] = [
        'message.started',
        'message.delta',
        'message.completed',
      ]
      expect(messageTypes).toHaveLength(3)
      expect(messageTypes).toContain('message.started')
      expect(messageTypes).toContain('message.delta')
      expect(messageTypes).toContain('message.completed')
    })

    it('should define all tool event types', () => {
      const toolTypes: RuntimeEventType[] = ['tool.started', 'tool.completed', 'tool.failed']
      expect(toolTypes).toHaveLength(3)
      expect(toolTypes).toContain('tool.started')
      expect(toolTypes).toContain('tool.completed')
      expect(toolTypes).toContain('tool.failed')
    })

    it('should have exactly 10 event types', () => {
      const allTypes: RuntimeEventType[] = [
        'run.started',
        'run.completed',
        'run.failed',
        'run.cancelled',
        'message.started',
        'message.delta',
        'message.completed',
        'tool.started',
        'tool.completed',
        'tool.failed',
      ]
      expect(allTypes).toHaveLength(10)
    })
  })

  describe('RunStartedEvent', () => {
    it('should define required fields', () => {
      const event: RunStartedEvent = {
        type: 'run.started',
        runId,
        sessionId,
        timestamp: Date.now(),
      }

      expect(event.type).toBe('run.started')
      expect(event.runId).toBe(runId)
      expect(event.sessionId).toBe(sessionId)
      expect(event.timestamp).toBeGreaterThan(0)
    })
  })

  describe('RunCompletedEvent', () => {
    it('should define required fields', () => {
      const event: RunCompletedEvent = {
        type: 'run.completed',
        runId,
        sessionId,
        timestamp: Date.now(),
      }

      expect(event.type).toBe('run.completed')
      expect(event.runId).toBe(runId)
      expect(event.sessionId).toBe(sessionId)
    })
  })

  describe('RunFailedEvent', () => {
    it('should define required fields with error', () => {
      const error = new ProviderError('API_ERROR', 'Provider failed')
      const event: RunFailedEvent = {
        type: 'run.failed',
        runId,
        sessionId,
        error,
        timestamp: Date.now(),
      }

      expect(event.type).toBe('run.failed')
      expect(event.runId).toBe(runId)
      expect(event.sessionId).toBe(sessionId)
      expect(event.error).toBeInstanceOf(ProviderError)
      expect(event.error.code).toBe('API_ERROR')
    })

    it('should accept various error types', () => {
      const toolError = new ToolError('EXEC_FAILED', 'Tool failed')
      const event: RunFailedEvent = {
        type: 'run.failed',
        runId,
        sessionId,
        error: toolError,
        timestamp: Date.now(),
      }

      expect(event.error).toBeInstanceOf(ToolError)
    })
  })

  describe('RunCancelledEvent', () => {
    it('should define required fields', () => {
      const event: RunCancelledEvent = {
        type: 'run.cancelled',
        runId,
        sessionId,
        timestamp: Date.now(),
      }

      expect(event.type).toBe('run.cancelled')
      expect(event.runId).toBe(runId)
      expect(event.sessionId).toBe(sessionId)
    })
  })

  describe('MessageStartedEvent', () => {
    it('should define required fields with message', () => {
      const event: MessageStartedEvent = {
        type: 'message.started',
        runId,
        messageId: 'msg_001',
        message: {
          id: 'msg_001',
          role: 'assistant',
          content: [],
          createdAt: Date.now(),
        },
        timestamp: Date.now(),
      }

      expect(event.type).toBe('message.started')
      expect(event.runId).toBe(runId)
      expect(event.messageId).toBe('msg_001')
      expect(event.message.role).toBe('assistant')
    })
  })

  describe('MessageDeltaChannel', () => {
    it('should accept valid channels', () => {
      const channels: MessageDeltaChannel[] = ['text', 'thinking']
      expect(channels).toHaveLength(2)
      expect(channels).toContain('text')
      expect(channels).toContain('thinking')
    })
  })

  describe('MessageDeltaPayload', () => {
    it('should define content field', () => {
      const payload: MessageDeltaPayload = {
        content: 'Hello, world!',
      }

      expect(payload.content).toBe('Hello, world!')
    })

    it('should accept empty content', () => {
      const payload: MessageDeltaPayload = {
        content: '',
      }

      expect(payload.content).toBe('')
    })

    it('should accept long content', () => {
      const payload: MessageDeltaPayload = {
        content: 'a'.repeat(10000),
      }

      expect(payload.content).toHaveLength(10000)
    })
  })

  describe('MessageDeltaEvent', () => {
    it('should define required fields', () => {
      const event: MessageDeltaEvent = {
        type: 'message.delta',
        runId,
        messageId: 'msg_001',
        sequence: 1,
        channel: 'text',
        payload: { content: 'Hello' },
        timestamp: Date.now(),
      }

      expect(event.type).toBe('message.delta')
      expect(event.runId).toBe(runId)
      expect(event.messageId).toBe('msg_001')
      expect(event.sequence).toBe(1)
      expect(event.channel).toBe('text')
      expect(event.payload.content).toBe('Hello')
    })

    it('should support thinking channel', () => {
      const event: MessageDeltaEvent = {
        type: 'message.delta',
        runId,
        messageId: 'msg_001',
        sequence: 2,
        channel: 'thinking',
        payload: { content: 'Analyzing...' },
        timestamp: Date.now(),
      }

      expect(event.channel).toBe('thinking')
      expect(event.payload.content).toBe('Analyzing...')
    })

    it('should support increasing sequence numbers', () => {
      const events: MessageDeltaEvent[] = [
        {
          type: 'message.delta',
          runId,
          messageId: 'msg_001',
          sequence: 1,
          channel: 'text',
          payload: { content: 'Hello' },
          timestamp: 1000,
        },
        {
          type: 'message.delta',
          runId,
          messageId: 'msg_001',
          sequence: 2,
          channel: 'text',
          payload: { content: ' world' },
          timestamp: 1001,
        },
        {
          type: 'message.delta',
          runId,
          messageId: 'msg_001',
          sequence: 3,
          channel: 'text',
          payload: { content: '!' },
          timestamp: 1002,
        },
      ]

      expect(events[0].sequence).toBeLessThan(events[1].sequence)
      expect(events[1].sequence).toBeLessThan(events[2].sequence)
    })
  })

  describe('MessageCompletedEvent', () => {
    it('should define required fields with complete message', () => {
      const event: MessageCompletedEvent = {
        type: 'message.completed',
        runId,
        messageId: 'msg_001',
        message: {
          id: 'msg_001',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello, world!' }],
          createdAt: Date.now(),
        },
        timestamp: Date.now(),
      }

      expect(event.type).toBe('message.completed')
      expect(event.runId).toBe(runId)
      expect(event.messageId).toBe('msg_001')
      expect(event.message.content).toHaveLength(1)
    })
  })

  describe('ToolStartedEvent', () => {
    it('should define required fields with invocation', () => {
      const event: ToolStartedEvent = {
        type: 'tool.started',
        runId,
        toolCallId: 'call_001',
        invocation: {
          toolCallId: 'call_001',
          toolName: 'read_file',
          args: { path: '/src/index.ts' },
        },
        timestamp: Date.now(),
      }

      expect(event.type).toBe('tool.started')
      expect(event.runId).toBe(runId)
      expect(event.toolCallId).toBe('call_001')
      expect(event.invocation.toolName).toBe('read_file')
    })
  })

  describe('ToolCompletedEvent', () => {
    it('should define required fields with result', () => {
      const event: ToolCompletedEvent = {
        type: 'tool.completed',
        runId,
        toolCallId: 'call_001',
        result: {
          toolCallId: 'call_001',
          result: 'file contents here',
        },
        timestamp: Date.now(),
      }

      expect(event.type).toBe('tool.completed')
      expect(event.runId).toBe(runId)
      expect(event.toolCallId).toBe('call_001')
      expect(event.result.result).toBe('file contents here')
    })
  })

  describe('ToolFailedEvent', () => {
    it('should define required fields with error', () => {
      const error = new ToolError('FILE_NOT_FOUND', 'File does not exist')
      const event: ToolFailedEvent = {
        type: 'tool.failed',
        runId,
        toolCallId: 'call_001',
        invocation: {
          toolCallId: 'call_001',
          toolName: 'read_file',
          args: { path: '/nonexistent.ts' },
        },
        error,
        timestamp: Date.now(),
      }

      expect(event.type).toBe('tool.failed')
      expect(event.runId).toBe(runId)
      expect(event.toolCallId).toBe('call_001')
      expect(event.error).toBeInstanceOf(ToolError)
      expect(event.error.code).toBe('FILE_NOT_FOUND')
    })
  })

  describe('RuntimeEvent discriminated union', () => {
    it('should accept RunStartedEvent', () => {
      const event: RuntimeEvent = {
        type: 'run.started',
        runId,
        sessionId,
        timestamp: Date.now(),
      }
      expect(event.type).toBe('run.started')
    })

    it('should accept RunCompletedEvent', () => {
      const event: RuntimeEvent = {
        type: 'run.completed',
        runId,
        sessionId,
        timestamp: Date.now(),
      }
      expect(event.type).toBe('run.completed')
    })

    it('should accept RunFailedEvent', () => {
      const event: RuntimeEvent = {
        type: 'run.failed',
        runId,
        sessionId,
        error: new ProviderError('ERR', 'Failed'),
        timestamp: Date.now(),
      }
      expect(event.type).toBe('run.failed')
    })

    it('should accept RunCancelledEvent', () => {
      const event: RuntimeEvent = {
        type: 'run.cancelled',
        runId,
        sessionId,
        timestamp: Date.now(),
      }
      expect(event.type).toBe('run.cancelled')
    })

    it('should accept MessageStartedEvent', () => {
      const event: RuntimeEvent = {
        type: 'message.started',
        runId,
        messageId: 'msg_001',
        message: {
          id: 'msg_001',
          role: 'assistant',
          content: [],
          createdAt: Date.now(),
        },
        timestamp: Date.now(),
      }
      expect(event.type).toBe('message.started')
    })

    it('should accept MessageDeltaEvent', () => {
      const event: RuntimeEvent = {
        type: 'message.delta',
        runId,
        messageId: 'msg_001',
        sequence: 1,
        channel: 'text',
        payload: { content: 'test' },
        timestamp: Date.now(),
      }
      expect(event.type).toBe('message.delta')
    })

    it('should accept MessageCompletedEvent', () => {
      const event: RuntimeEvent = {
        type: 'message.completed',
        runId,
        messageId: 'msg_001',
        message: {
          id: 'msg_001',
          role: 'assistant',
          content: [],
          createdAt: Date.now(),
        },
        timestamp: Date.now(),
      }
      expect(event.type).toBe('message.completed')
    })

    it('should accept ToolStartedEvent', () => {
      const event: RuntimeEvent = {
        type: 'tool.started',
        runId,
        toolCallId: 'call_001',
        invocation: {
          toolCallId: 'call_001',
          toolName: 'test',
          args: {},
        },
        timestamp: Date.now(),
      }
      expect(event.type).toBe('tool.started')
    })

    it('should accept ToolCompletedEvent', () => {
      const event: RuntimeEvent = {
        type: 'tool.completed',
        runId,
        toolCallId: 'call_001',
        result: {
          toolCallId: 'call_001',
          result: 'done',
        },
        timestamp: Date.now(),
      }
      expect(event.type).toBe('tool.completed')
    })

    it('should accept ToolFailedEvent', () => {
      const event: RuntimeEvent = {
        type: 'tool.failed',
        runId,
        toolCallId: 'call_001',
        invocation: {
          toolCallId: 'call_001',
          toolName: 'test',
          args: {},
        },
        error: new ToolError('ERR', 'Failed'),
        timestamp: Date.now(),
      }
      expect(event.type).toBe('tool.failed')
    })
  })

  describe('Event filtering patterns', () => {
    it('should filter run events', () => {
      const events: RuntimeEvent[] = [
        { type: 'run.started', runId, sessionId, timestamp: 1000 },
        {
          type: 'message.started',
          runId,
          messageId: 'm1',
          message: { id: 'm1', role: 'assistant', content: [], createdAt: 1000 },
          timestamp: 1100,
        },
        { type: 'run.completed', runId, sessionId, timestamp: 2000 },
      ]

      const runEvents = events.filter(
        (e): e is RunStartedEvent | RunCompletedEvent | RunFailedEvent | RunCancelledEvent =>
          e.type.startsWith('run.')
      )

      expect(runEvents).toHaveLength(2)
    })
  })
})
