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

  describe('Type narrowing with switch', () => {
    it('should narrow types correctly in switch statement', () => {
      const events: RuntimeEvent[] = [
        {
          type: 'run.started',
          runId,
          sessionId,
          timestamp: 1000,
        },
        {
          type: 'run.completed',
          runId,
          sessionId,
          timestamp: 2000,
        },
        {
          type: 'run.failed',
          runId,
          sessionId,
          error: new ProviderError('ERR', 'Failed'),
          timestamp: 3000,
        },
        {
          type: 'run.cancelled',
          runId,
          sessionId,
          timestamp: 4000,
        },
        {
          type: 'message.started',
          runId,
          messageId: 'msg_001',
          message: {
            id: 'msg_001',
            role: 'assistant',
            content: [],
            createdAt: 5000,
          },
          timestamp: 5000,
        },
        {
          type: 'message.delta',
          runId,
          messageId: 'msg_001',
          sequence: 1,
          channel: 'text',
          payload: { content: 'Hello' },
          timestamp: 5100,
        },
        {
          type: 'message.completed',
          runId,
          messageId: 'msg_001',
          message: {
            id: 'msg_001',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello' }],
            createdAt: 5200,
          },
          timestamp: 5200,
        },
        {
          type: 'tool.started',
          runId,
          toolCallId: 'call_001',
          invocation: {
            toolCallId: 'call_001',
            toolName: 'test',
            args: {},
          },
          timestamp: 6000,
        },
        {
          type: 'tool.completed',
          runId,
          toolCallId: 'call_001',
          result: {
            toolCallId: 'call_001',
            result: 'done',
          },
          timestamp: 7000,
        },
        {
          type: 'tool.failed',
          runId,
          toolCallId: 'call_002',
          invocation: {
            toolCallId: 'call_002',
            toolName: 'fail',
            args: {},
          },
          error: new ToolError('ERR', 'Failed'),
          timestamp: 8000,
        },
      ]

      for (const event of events) {
        switch (event.type) {
          case 'run.started':
            expect(event.runId).toBeDefined()
            expect(event.sessionId).toBeDefined()
            break
          case 'run.completed':
            expect(event.runId).toBeDefined()
            expect(event.sessionId).toBeDefined()
            break
          case 'run.failed':
            expect(event.runId).toBeDefined()
            expect(event.error).toBeInstanceOf(ProviderError)
            break
          case 'run.cancelled':
            expect(event.runId).toBeDefined()
            break
          case 'message.started':
            expect(event.messageId).toBeDefined()
            expect(event.message).toBeDefined()
            break
          case 'message.delta':
            expect(event.sequence).toBeGreaterThanOrEqual(1)
            expect(event.channel).toBeDefined()
            expect(event.payload.content).toBeDefined()
            break
          case 'message.completed':
            expect(event.messageId).toBeDefined()
            expect(event.message).toBeDefined()
            break
          case 'tool.started':
            expect(event.toolCallId).toBeDefined()
            expect(event.invocation).toBeDefined()
            break
          case 'tool.completed':
            expect(event.toolCallId).toBeDefined()
            expect(event.result).toBeDefined()
            break
          case 'tool.failed':
            expect(event.toolCallId).toBeDefined()
            expect(event.error).toBeInstanceOf(ToolError)
            break
        }
      }
    })
  })

  describe('Type narrowing with if', () => {
    it('should narrow run events correctly', () => {
      const event: RuntimeEvent = {
        type: 'run.started',
        runId,
        sessionId,
        timestamp: Date.now(),
      }

      if (event.type === 'run.started') {
        expect(event.runId).toBeDefined()
        expect(event.sessionId).toBeDefined()
        // @ts-expect-error - error should not exist on RunStartedEvent
        expect(event.error).toBeUndefined()
      }
    })

    it('should narrow message.delta events correctly', () => {
      const event: RuntimeEvent = {
        type: 'message.delta',
        runId,
        messageId: 'msg_001',
        sequence: 1,
        channel: 'text',
        payload: { content: 'test' },
        timestamp: Date.now(),
      }

      if (event.type === 'message.delta') {
        expect(event.sequence).toBe(1)
        expect(event.channel).toBe('text')
        expect(event.payload.content).toBe('test')
        // @ts-expect-error - message should not exist on MessageDeltaEvent
        expect(event.message).toBeUndefined()
      }
    })

    it('should narrow tool events correctly', () => {
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

      if (event.type === 'tool.failed') {
        expect(event.invocation).toBeDefined()
        expect(event.error).toBeInstanceOf(ToolError)
        // @ts-expect-error - result should not exist on ToolFailedEvent
        expect(event.result).toBeUndefined()
      }
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

    it('should filter message events', () => {
      const events: RuntimeEvent[] = [
        { type: 'run.started', runId, sessionId, timestamp: 1000 },
        {
          type: 'message.started',
          runId,
          messageId: 'm1',
          message: { id: 'm1', role: 'assistant', content: [], createdAt: 1000 },
          timestamp: 1100,
        },
        {
          type: 'message.delta',
          runId,
          messageId: 'm1',
          sequence: 1,
          channel: 'text',
          payload: { content: 'Hi' },
          timestamp: 1110,
        },
        { type: 'run.completed', runId, sessionId, timestamp: 2000 },
      ]

      const messageEvents = events.filter(
        (e): e is MessageStartedEvent | MessageDeltaEvent | MessageCompletedEvent =>
          e.type.startsWith('message.')
      )

      expect(messageEvents).toHaveLength(2)
    })

    it('should filter tool events', () => {
      const events: RuntimeEvent[] = [
        { type: 'run.started', runId, sessionId, timestamp: 1000 },
        {
          type: 'tool.started',
          runId,
          toolCallId: 't1',
          invocation: { toolCallId: 't1', toolName: 'test', args: {} },
          timestamp: 1100,
        },
        {
          type: 'tool.completed',
          runId,
          toolCallId: 't1',
          result: { toolCallId: 't1', result: 'done' },
          timestamp: 1200,
        },
        { type: 'run.completed', runId, sessionId, timestamp: 2000 },
      ]

      const toolEvents = events.filter(
        (e): e is ToolStartedEvent | ToolCompletedEvent | ToolFailedEvent =>
          e.type.startsWith('tool.')
      )

      expect(toolEvents).toHaveLength(2)
    })
  })

  describe('Real-world event stream scenario', () => {
    it('should support complete conversation flow', () => {
      const events: RuntimeEvent[] = [
        // Run starts
        {
          type: 'run.started',
          runId,
          sessionId,
          timestamp: 1000,
        },
        // Assistant message begins
        {
          type: 'message.started',
          runId,
          messageId: 'msg_001',
          message: {
            id: 'msg_001',
            role: 'assistant',
            content: [],
            createdAt: 1100,
          },
          timestamp: 1100,
        },
        // Thinking delta
        {
          type: 'message.delta',
          runId,
          messageId: 'msg_001',
          sequence: 1,
          channel: 'thinking',
          payload: { content: 'Analyzing request...' },
          timestamp: 1150,
        },
        // Text deltas
        {
          type: 'message.delta',
          runId,
          messageId: 'msg_001',
          sequence: 2,
          channel: 'text',
          payload: { content: 'I will ' },
          timestamp: 1200,
        },
        {
          type: 'message.delta',
          runId,
          messageId: 'msg_001',
          sequence: 3,
          channel: 'text',
          payload: { content: 'read the file.' },
          timestamp: 1250,
        },
        // Message completes
        {
          type: 'message.completed',
          runId,
          messageId: 'msg_001',
          message: {
            id: 'msg_001',
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Analyzing request...' },
              { type: 'text', text: 'I will read the file.' },
            ],
            createdAt: 1100,
          },
          timestamp: 1300,
        },
        // Tool starts
        {
          type: 'tool.started',
          runId,
          toolCallId: 'call_001',
          invocation: {
            toolCallId: 'call_001',
            toolName: 'read_file',
            args: { path: '/src/index.ts' },
          },
          timestamp: 1400,
        },
        // Tool completes
        {
          type: 'tool.completed',
          runId,
          toolCallId: 'call_001',
          result: {
            toolCallId: 'call_001',
            result: 'export const hello = "world"',
          },
          timestamp: 1500,
        },
        // Run completes
        {
          type: 'run.completed',
          runId,
          sessionId,
          timestamp: 2000,
        },
      ]

      // Verify event sequence
      expect(events).toHaveLength(9)
      expect(events[0].type).toBe('run.started')
      expect(events[events.length - 1].type).toBe('run.completed')

      // Count event types
      const typeCounts = events.reduce(
        (acc, event) => {
          acc[event.type] = (acc[event.type] || 0) + 1
          return acc
        },
        {} as Record<string, number>
      )

      expect(typeCounts['run.started']).toBe(1)
      expect(typeCounts['message.delta']).toBe(3)
      expect(typeCounts['tool.completed']).toBe(1)
      expect(typeCounts['run.completed']).toBe(1)
    })

    it('should support error and cancellation flow', () => {
      const events: RuntimeEvent[] = [
        {
          type: 'run.started',
          runId,
          sessionId,
          timestamp: 1000,
        },
        {
          type: 'tool.started',
          runId,
          toolCallId: 'call_001',
          invocation: {
            toolCallId: 'call_001',
            toolName: 'dangerous_op',
            args: {},
          },
          timestamp: 1100,
        },
        {
          type: 'tool.failed',
          runId,
          toolCallId: 'call_001',
          invocation: {
            toolCallId: 'call_001',
            toolName: 'dangerous_op',
            args: {},
          },
          error: new ToolError('PERMISSION_DENIED', 'Operation not allowed'),
          timestamp: 1200,
        },
        {
          type: 'run.failed',
          runId,
          sessionId,
          error: new ProviderError('TOOL_ERROR', 'Tool execution failed'),
          timestamp: 1300,
        },
      ]

      expect(events).toHaveLength(4)
      expect(events[2].type).toBe('tool.failed')
      expect(events[3].type).toBe('run.failed')
    })
  })
})
