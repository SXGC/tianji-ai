import { describe, expect, it } from 'vitest'
import type {
  Delta,
  DeltaOp,
  MessageDelta,
  ToolProgressChannel,
  ToolProgressDelta,
} from '../delta.js'
import type { MessageDeltaChannel } from '../events.js'
import { createRunId } from '../identifiers.js'

describe('delta types', () => {
  const runId = createRunId('run_456')

  describe('DeltaOp', () => {
    it('should define all operation types', () => {
      const ops: DeltaOp[] = ['append', 'replace', 'complete']
      expect(ops).toHaveLength(3)
      expect(ops).toContain('append')
      expect(ops).toContain('replace')
      expect(ops).toContain('complete')
    })
  })

  describe('MessageDeltaChannel', () => {
    it('should define all channel types', () => {
      const channels: MessageDeltaChannel[] = ['text', 'thinking']
      expect(channels).toHaveLength(2)
      expect(channels).toContain('text')
      expect(channels).toContain('thinking')
    })
  })

  describe('ToolProgressChannel', () => {
    it('should define all channel types', () => {
      const channels: ToolProgressChannel[] = ['stdout', 'stderr', 'progress', 'result']
      expect(channels).toHaveLength(4)
      expect(channels).toContain('stdout')
      expect(channels).toContain('stderr')
      expect(channels).toContain('progress')
      expect(channels).toContain('result')
    })
  })

  describe('MessageDelta', () => {
    it('should define required fields', () => {
      const delta: MessageDelta = {
        runId,
        messageId: 'msg_001',
        sequence: 1,
        op: 'append',
        channel: 'text',
        payload: 'Hello',
        timestamp: Date.now(),
      }

      expect(delta.runId).toBe(runId)
      expect(delta.messageId).toBe('msg_001')
      expect(delta.sequence).toBe(1)
      expect(delta.op).toBe('append')
      expect(delta.channel).toBe('text')
      expect(delta.payload).toBe('Hello')
      expect(delta.timestamp).toBeGreaterThan(0)
    })

    it('should accept string payload', () => {
      const delta: MessageDelta = {
        runId,
        messageId: 'msg_001',
        sequence: 1,
        op: 'append',
        channel: 'text',
        payload: 'Some text content',
        timestamp: Date.now(),
      }

      expect(typeof delta.payload).toBe('string')
    })

    it('should accept object payload', () => {
      const delta: MessageDelta = {
        runId,
        messageId: 'msg_001',
        sequence: 1,
        op: 'append',
        channel: 'text',
        payload: { text: 'Hello', metadata: { source: 'user' } },
        timestamp: Date.now(),
      }

      expect(typeof delta.payload).toBe('object')
    })

    it('should accept thinking channel', () => {
      const delta: MessageDelta = {
        runId,
        messageId: 'msg_001',
        sequence: 1,
        op: 'append',
        channel: 'thinking',
        payload: 'Analyzing request...',
        timestamp: Date.now(),
      }

      expect(delta.channel).toBe('thinking')
    })

    it('should accept append operation', () => {
      const delta: MessageDelta = {
        runId,
        messageId: 'msg_001',
        sequence: 1,
        op: 'append',
        channel: 'text',
        payload: ' world',
        timestamp: Date.now(),
      }

      expect(delta.op).toBe('append')
    })

    it('should accept replace operation', () => {
      const delta: MessageDelta = {
        runId,
        messageId: 'msg_001',
        sequence: 5,
        op: 'replace',
        channel: 'text',
        payload: 'Complete replacement',
        timestamp: Date.now(),
      }

      expect(delta.op).toBe('replace')
    })

    it('should accept complete operation', () => {
      const delta: MessageDelta = {
        runId,
        messageId: 'msg_001',
        sequence: 10,
        op: 'complete',
        channel: 'text',
        payload: null,
        timestamp: Date.now(),
      }

      expect(delta.op).toBe('complete')
    })

    it('should support increasing sequence numbers', () => {
      const deltas: MessageDelta[] = [
        {
          runId,
          messageId: 'msg_001',
          sequence: 1,
          op: 'append',
          channel: 'text',
          payload: 'Hello',
          timestamp: 1000,
        },
        {
          runId,
          messageId: 'msg_001',
          sequence: 2,
          op: 'append',
          channel: 'text',
          payload: ' world',
          timestamp: 1001,
        },
        {
          runId,
          messageId: 'msg_001',
          sequence: 3,
          op: 'append',
          channel: 'text',
          payload: '!',
          timestamp: 1002,
        },
      ]

      expect(deltas[0].sequence).toBeLessThan(deltas[1].sequence)
      expect(deltas[1].sequence).toBeLessThan(deltas[2].sequence)
    })
  })

  describe('ToolProgressDelta', () => {
    it('should define required fields', () => {
      const delta: ToolProgressDelta = {
        runId,
        toolCallId: 'call_001',
        sequence: 1,
        op: 'append',
        channel: 'stdout',
        payload: 'Processing...',
        timestamp: Date.now(),
      }

      expect(delta.runId).toBe(runId)
      expect(delta.toolCallId).toBe('call_001')
      expect(delta.sequence).toBe(1)
      expect(delta.op).toBe('append')
      expect(delta.channel).toBe('stdout')
      expect(delta.payload).toBe('Processing...')
      expect(delta.timestamp).toBeGreaterThan(0)
    })

    it('should accept stdout channel', () => {
      const delta: ToolProgressDelta = {
        runId,
        toolCallId: 'call_001',
        sequence: 1,
        op: 'append',
        channel: 'stdout',
        payload: 'Output line 1\n',
        timestamp: Date.now(),
      }

      expect(delta.channel).toBe('stdout')
    })

    it('should accept stderr channel', () => {
      const delta: ToolProgressDelta = {
        runId,
        toolCallId: 'call_001',
        sequence: 1,
        op: 'append',
        channel: 'stderr',
        payload: 'Warning: deprecated API\n',
        timestamp: Date.now(),
      }

      expect(delta.channel).toBe('stderr')
    })

    it('should accept progress channel', () => {
      const delta: ToolProgressDelta = {
        runId,
        toolCallId: 'call_001',
        sequence: 1,
        op: 'replace',
        channel: 'progress',
        payload: { current: 5, total: 10, message: 'Halfway done' },
        timestamp: Date.now(),
      }

      expect(delta.channel).toBe('progress')
      expect(typeof delta.payload).toBe('object')
    })

    it('should accept result channel', () => {
      const delta: ToolProgressDelta = {
        runId,
        toolCallId: 'call_001',
        sequence: 1,
        op: 'replace',
        channel: 'result',
        payload: { files: ['a.txt', 'b.txt'], count: 2 },
        timestamp: Date.now(),
      }

      expect(delta.channel).toBe('result')
    })

    it('should accept append operation', () => {
      const delta: ToolProgressDelta = {
        runId,
        toolCallId: 'call_001',
        sequence: 1,
        op: 'append',
        channel: 'stdout',
        payload: 'More output\n',
        timestamp: Date.now(),
      }

      expect(delta.op).toBe('append')
    })

    it('should accept replace operation', () => {
      const delta: ToolProgressDelta = {
        runId,
        toolCallId: 'call_001',
        sequence: 1,
        op: 'replace',
        channel: 'progress',
        payload: { percent: 100 },
        timestamp: Date.now(),
      }

      expect(delta.op).toBe('replace')
    })

    it('should accept complete operation', () => {
      const delta: ToolProgressDelta = {
        runId,
        toolCallId: 'call_001',
        sequence: 5,
        op: 'complete',
        channel: 'result',
        payload: { success: true },
        timestamp: Date.now(),
      }

      expect(delta.op).toBe('complete')
    })

    it('should support increasing sequence numbers', () => {
      const deltas: ToolProgressDelta[] = [
        {
          runId,
          toolCallId: 'call_001',
          sequence: 1,
          op: 'append',
          channel: 'stdout',
          payload: 'Starting\n',
          timestamp: 1000,
        },
        {
          runId,
          toolCallId: 'call_001',
          sequence: 2,
          op: 'append',
          channel: 'stdout',
          payload: 'Processing\n',
          timestamp: 1001,
        },
        {
          runId,
          toolCallId: 'call_001',
          sequence: 3,
          op: 'complete',
          channel: 'result',
          payload: 'Done',
          timestamp: 1002,
        },
      ]

      expect(deltas[0].sequence).toBeLessThan(deltas[1].sequence)
      expect(deltas[1].sequence).toBeLessThan(deltas[2].sequence)
    })
  })

  describe('Delta union type', () => {
    it('should accept MessageDelta', () => {
      const delta: Delta = {
        runId,
        messageId: 'msg_001',
        sequence: 1,
        op: 'append',
        channel: 'text',
        payload: 'Hello',
        timestamp: Date.now(),
      }
      expect(delta.runId).toBe(runId)
    })

    it('should accept ToolProgressDelta', () => {
      const delta: Delta = {
        runId,
        toolCallId: 'call_001',
        sequence: 1,
        op: 'append',
        channel: 'stdout',
        payload: 'Output',
        timestamp: Date.now(),
      }
      expect(delta.runId).toBe(runId)
    })
  })

  describe('Type narrowing', () => {
    it('should narrow to MessageDelta using messageId check', () => {
      const delta: Delta = {
        runId,
        messageId: 'msg_001',
        sequence: 1,
        op: 'append',
        channel: 'text',
        payload: 'Hello',
        timestamp: Date.now(),
      }

      if ('messageId' in delta) {
        expect(delta.messageId).toBe('msg_001')
        expect(delta.channel).toBe('text')
        // @ts-expect-error - toolCallId should not exist on MessageDelta
        expect(delta.toolCallId).toBeUndefined()
      }
    })

    it('should narrow to ToolProgressDelta using toolCallId check', () => {
      const delta: Delta = {
        runId,
        toolCallId: 'call_001',
        sequence: 1,
        op: 'append',
        channel: 'stdout',
        payload: 'Output',
        timestamp: Date.now(),
      }

      if ('toolCallId' in delta) {
        expect(delta.toolCallId).toBe('call_001')
        expect(delta.channel).toBe('stdout')
        // @ts-expect-error - messageId should not exist on ToolProgressDelta
        expect(delta.messageId).toBeUndefined()
      }
    })
  })

  describe('Real-world delta streaming scenarios', () => {
    it('should support complete message streaming flow', () => {
      const deltas: MessageDelta[] = [
        {
          runId,
          messageId: 'msg_001',
          sequence: 1,
          op: 'append',
          channel: 'thinking',
          payload: 'Let me think about this...',
          timestamp: 1000,
        },
        {
          runId,
          messageId: 'msg_001',
          sequence: 2,
          op: 'append',
          channel: 'text',
          payload: 'Hello',
          timestamp: 1001,
        },
        {
          runId,
          messageId: 'msg_001',
          sequence: 3,
          op: 'append',
          channel: 'text',
          payload: ', world!',
          timestamp: 1002,
        },
        {
          runId,
          messageId: 'msg_001',
          sequence: 4,
          op: 'complete',
          channel: 'text',
          payload: null,
          timestamp: 1003,
        },
      ]

      expect(deltas).toHaveLength(4)
      expect(deltas[0].channel).toBe('thinking')
      expect(deltas[1].channel).toBe('text')
      expect(deltas[3].op).toBe('complete')
    })

    it('should support tool execution progress flow', () => {
      const deltas: ToolProgressDelta[] = [
        {
          runId,
          toolCallId: 'call_001',
          sequence: 1,
          op: 'replace',
          channel: 'progress',
          payload: { percent: 0, message: 'Starting' },
          timestamp: 1000,
        },
        {
          runId,
          toolCallId: 'call_001',
          sequence: 2,
          op: 'append',
          channel: 'stdout',
          payload: 'Processing file 1\n',
          timestamp: 1001,
        },
        {
          runId,
          toolCallId: 'call_001',
          sequence: 3,
          op: 'replace',
          channel: 'progress',
          payload: { percent: 50, message: 'Halfway' },
          timestamp: 1002,
        },
        {
          runId,
          toolCallId: 'call_001',
          sequence: 4,
          op: 'append',
          channel: 'stdout',
          payload: 'Processing file 2\n',
          timestamp: 1003,
        },
        {
          runId,
          toolCallId: 'call_001',
          sequence: 5,
          op: 'replace',
          channel: 'result',
          payload: { files: ['file1', 'file2'], success: true },
          timestamp: 1004,
        },
        {
          runId,
          toolCallId: 'call_001',
          sequence: 6,
          op: 'complete',
          channel: 'result',
          payload: null,
          timestamp: 1005,
        },
      ]

      expect(deltas).toHaveLength(6)
      expect(deltas[0].channel).toBe('progress')
      expect(deltas[1].channel).toBe('stdout')
      expect(deltas[4].channel).toBe('result')
      expect(deltas[5].op).toBe('complete')
    })

    it('should support mixed delta stream with type discrimination', () => {
      const deltas: Delta[] = [
        // Message delta
        {
          runId,
          messageId: 'msg_001',
          sequence: 1,
          op: 'append',
          channel: 'text',
          payload: 'I will run the tool.',
          timestamp: 1000,
        },
        // Tool progress delta
        {
          runId,
          toolCallId: 'call_001',
          sequence: 1,
          op: 'append',
          channel: 'stdout',
          payload: 'Tool output\n',
          timestamp: 1001,
        },
        // Another message delta
        {
          runId,
          messageId: 'msg_001',
          sequence: 2,
          op: 'append',
          channel: 'text',
          payload: ' Done.',
          timestamp: 1002,
        },
      ]

      const messageDeltas = deltas.filter((d): d is MessageDelta => 'messageId' in d)
      const toolDeltas = deltas.filter((d): d is ToolProgressDelta => 'toolCallId' in d)

      expect(messageDeltas).toHaveLength(2)
      expect(toolDeltas).toHaveLength(1)
    })

    it('should support replace operation for error correction', () => {
      const deltas: MessageDelta[] = [
        {
          runId,
          messageId: 'msg_001',
          sequence: 1,
          op: 'append',
          channel: 'text',
          payload: 'The answer is 42',
          timestamp: 1000,
        },
        {
          runId,
          messageId: 'msg_001',
          sequence: 2,
          op: 'replace',
          channel: 'text',
          payload: 'The answer is 43',
          timestamp: 1001,
        },
      ]

      expect(deltas[0].op).toBe('append')
      expect(deltas[1].op).toBe('replace')
    })
  })

  describe('Payload flexibility', () => {
    it('should accept null payload', () => {
      const delta: MessageDelta = {
        runId,
        messageId: 'msg_001',
        sequence: 1,
        op: 'complete',
        channel: 'text',
        payload: null,
        timestamp: Date.now(),
      }

      expect(delta.payload).toBeNull()
    })

    it('should accept undefined payload', () => {
      const delta: MessageDelta = {
        runId,
        messageId: 'msg_001',
        sequence: 1,
        op: 'complete',
        channel: 'text',
        payload: undefined,
        timestamp: Date.now(),
      }

      expect(delta.payload).toBeUndefined()
    })

    it('should accept array payload', () => {
      const delta: ToolProgressDelta = {
        runId,
        toolCallId: 'call_001',
        sequence: 1,
        op: 'replace',
        channel: 'result',
        payload: ['item1', 'item2', 'item3'],
        timestamp: Date.now(),
      }

      expect(Array.isArray(delta.payload)).toBe(true)
    })

    it('should accept number payload', () => {
      const delta: ToolProgressDelta = {
        runId,
        toolCallId: 'call_001',
        sequence: 1,
        op: 'replace',
        channel: 'progress',
        payload: 42,
        timestamp: Date.now(),
      }

      expect(typeof delta.payload).toBe('number')
    })
  })
})
