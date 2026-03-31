import { describe, expect, expectTypeOf, it } from 'vitest'
import { ProviderError, ToolError } from '../errors.js'
import type {
  RunCancelledEvent,
  RunCompletedEvent,
  RunFailedEvent,
  RunStartedEvent,
  RuntimeEvent,
} from '../events.js'
import { createRunId, createSessionId } from '../identifiers.js'
import type { RunId } from '../identifiers.js'
import type { RunTriggerType } from '../snapshot.js'

describe('events types', () => {
  const sessionId = createSessionId('session_123')
  const runId = createRunId('run_456')
  const parentRunId = createRunId('run_parent') as RunId

  const createLineageFields = (triggerType: RunTriggerType) => ({
    runId,
    sessionId,
    triggerType,
    parentRunId: triggerType === 'new' ? undefined : parentRunId,
    timestamp: Date.now(),
  })

  describe('run lifecycle contracts', () => {
    it('should expose shared lineage fields on every run lifecycle event', () => {
      expectTypeOf<RunStartedEvent>().toHaveProperty('triggerType')
      expectTypeOf<RunStartedEvent>().toHaveProperty('parentRunId')
      expectTypeOf<RunCompletedEvent>().toHaveProperty('triggerType')
      expectTypeOf<RunCompletedEvent>().toHaveProperty('parentRunId')
      expectTypeOf<RunFailedEvent>().toHaveProperty('triggerType')
      expectTypeOf<RunFailedEvent>().toHaveProperty('parentRunId')
      expectTypeOf<RunFailedEvent>().toHaveProperty('error')
      expectTypeOf<RunCancelledEvent>().toHaveProperty('triggerType')
      expectTypeOf<RunCancelledEvent>().toHaveProperty('parentRunId')
    })

    it('should encode lineage semantics consistently across run lifecycle events', () => {
      const started: RunStartedEvent = {
        type: 'run.started',
        ...createLineageFields('new'),
      }
      const resumed: RunStartedEvent = {
        type: 'run.started',
        ...createLineageFields('resume'),
      }
      const retried: RunFailedEvent = {
        type: 'run.failed',
        ...createLineageFields('retry'),
        error: new ToolError('EXEC_FAILED', 'retry failed'),
      }

      expect(started.parentRunId).toBeUndefined()
      expect(resumed.parentRunId).toBe(parentRunId)
      expect(retried.parentRunId).toBe(parentRunId)
    })

    it('should keep lineage fields available after narrowing runtime events to run events', () => {
      const events: RuntimeEvent[] = [
        {
          type: 'run.started',
          runId,
          sessionId,
          triggerType: 'new',
          parentRunId: undefined,
          timestamp: 1000,
        },
        {
          type: 'message.started',
          runId,
          messageId: 'm1',
          message: { id: 'm1', role: 'assistant', content: [], createdAt: 1000 },
          timestamp: 1100,
        },
        {
          type: 'run.completed',
          ...createLineageFields('resume'),
          timestamp: 2000,
        },
      ]

      const runEvents = events.filter(
        (e): e is RunStartedEvent | RunCompletedEvent | RunFailedEvent | RunCancelledEvent =>
          e.type.startsWith('run.')
      )

      expect(runEvents[0]?.triggerType).toBe('new')
      expect(runEvents[0]?.parentRunId).toBeUndefined()
      expect(runEvents[1]?.triggerType).toBe('resume')
      expect(runEvents[1]?.parentRunId).toBe(parentRunId)
    })

    it('should keep event-specific fields available after discriminating runtime events', () => {
      const events: RuntimeEvent[] = [
        {
          type: 'run.failed',
          ...createLineageFields('retry'),
          error: new ProviderError('API_ERROR', 'provider failed'),
        },
        {
          type: 'run.completed',
          ...createLineageFields('resume'),
        },
      ]

      const failure = events.find((event): event is RunFailedEvent => event.type === 'run.failed')
      const completion = events.find(
        (event): event is RunCompletedEvent => event.type === 'run.completed'
      )

      expect(failure?.error.code).toBe('API_ERROR')
      expect(failure?.triggerType).toBe('retry')
      expect(failure?.parentRunId).toBe(parentRunId)
      expect(completion?.triggerType).toBe('resume')
      expect(completion?.parentRunId).toBe(parentRunId)
    })
  })
})
