import { describe, expect, it } from 'vitest'
import { createRunId, createSessionId, createTaskId } from '../identifiers.js'
import type { TaskAgentEvent, TaskEvent, TaskLifecycleEvent } from '../task-event.js'
import { TASK_LIFECYCLE_TYPES, TASK_STATUSES, isTerminalTaskStatus } from '../task-event.js'

describe('task-event types', () => {
  const taskId = createTaskId('task-001')
  const sessionId = createSessionId('session-001')
  const runId = createRunId('run-001')

  describe('TaskLifecycleEvent', () => {
    it('should construct a task.started lifecycle event', () => {
      const event: TaskLifecycleEvent = {
        kind: 'lifecycle',
        taskId,
        type: 'task.started',
        sequence: 1,
        timestamp: Date.now(),
        sessionId,
        runId,
        summary: 'started analysis',
      }
      expect(event.kind).toBe('lifecycle')
      expect(event.type).toBe('task.started')
    })

    it('should construct a task.completed lifecycle event', () => {
      const event: TaskLifecycleEvent = {
        kind: 'lifecycle',
        taskId,
        type: 'task.completed',
        sequence: 10,
        timestamp: Date.now(),
        summary: 'done',
      }
      expect(event.type).toBe('task.completed')
      expect(event.error).toBeUndefined()
    })

    it('should construct a task.failed lifecycle event with error', () => {
      const event: TaskLifecycleEvent = {
        kind: 'lifecycle',
        taskId,
        type: 'task.failed',
        sequence: 10,
        timestamp: Date.now(),
        error: 'agent crashed',
      }
      expect(event.type).toBe('task.failed')
      expect(event.error).toBe('agent crashed')
    })

    it('should construct a task.waiting lifecycle event', () => {
      const event: TaskLifecycleEvent = {
        kind: 'lifecycle',
        taskId,
        type: 'task.waiting',
        sequence: 5,
        timestamp: Date.now(),
        summary: 'waiting for user input',
      }
      expect(event.type).toBe('task.waiting')
    })

    it('should construct a task.session.attached lifecycle event', () => {
      const event: TaskLifecycleEvent = {
        kind: 'lifecycle',
        taskId,
        type: 'task.session.attached',
        sequence: 2,
        timestamp: Date.now(),
        sessionId,
      }
      expect(event.type).toBe('task.session.attached')
      expect(event.sessionId).toBe(sessionId)
    })
  })

  describe('TaskAgentEvent', () => {
    it('should wrap a RuntimeEvent with task context', () => {
      const event: TaskAgentEvent = {
        kind: 'agent',
        taskId,
        sequence: 3,
        sessionId,
        runId,
        event: {
          type: 'message.delta',
          runId,
          messageId: 'msg-1',
          sequence: 0,
          channel: 'text',
          payload: { content: 'hello' },
          timestamp: Date.now(),
        },
      }
      expect(event.kind).toBe('agent')
      expect(event.event.type).toBe('message.delta')
    })
  })

  describe('TaskEvent discriminated union', () => {
    it('should narrow by kind field', () => {
      const events: TaskEvent[] = [
        {
          kind: 'lifecycle',
          taskId,
          type: 'task.started',
          sequence: 1,
          timestamp: Date.now(),
        },
        {
          kind: 'agent',
          taskId,
          sequence: 2,
          sessionId,
          runId,
          event: {
            type: 'run.started',
            runId,
            sessionId,
            triggerType: 'new',
            timestamp: Date.now(),
          },
        },
      ]

      const lifecycle = events.filter(
        (event): event is TaskLifecycleEvent => event.kind === 'lifecycle'
      )
      const agent = events.filter((event): event is TaskAgentEvent => event.kind === 'agent')

      expect(lifecycle).toHaveLength(1)
      expect(agent).toHaveLength(1)
      expect(lifecycle[0]!.type).toBe('task.started')
      expect(agent[0]!.event.type).toBe('run.started')
    })
  })

  describe('TaskStatus', () => {
    it('should include all expected status values', () => {
      const expected = [
        'pending',
        'running',
        'waiting',
        'completed',
        'failed',
        'cancelled',
        'observation_lost',
      ]
      expect(TASK_STATUSES).toEqual(expected)
    })

    it('should identify terminal statuses correctly', () => {
      expect(isTerminalTaskStatus('completed')).toBe(true)
      expect(isTerminalTaskStatus('failed')).toBe(true)
      expect(isTerminalTaskStatus('cancelled')).toBe(true)
      expect(isTerminalTaskStatus('observation_lost')).toBe(true)
      expect(isTerminalTaskStatus('pending')).toBe(false)
      expect(isTerminalTaskStatus('running')).toBe(false)
      expect(isTerminalTaskStatus('waiting')).toBe(false)
    })
  })

  describe('TaskLifecycleType', () => {
    it('should include all expected lifecycle types', () => {
      const expected = [
        'task.started',
        'task.waiting',
        'task.completed',
        'task.failed',
        'task.cancelled',
        'task.session.attached',
      ]
      expect(TASK_LIFECYCLE_TYPES).toEqual(expected)
    })
  })
})
