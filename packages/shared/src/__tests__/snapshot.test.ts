import { describe, expect, expectTypeOf, it } from 'vitest'
import type { RunId } from '../identifiers.js'
import { createRunId, createSessionId } from '../identifiers.js'
import type { RunSnapshot, RunStatus, RunTriggerType } from '../snapshot.js'

describe('snapshot types', () => {
  const sessionId = createSessionId('session_001')
  const runId = createRunId('run_001')
  const timestamp = Date.now()

  describe('RunSnapshot', () => {
    const parentRunId = createRunId('run_parent') as RunId

    const createRunSnapshot = (
      triggerType: RunTriggerType,
      overrides: Partial<RunSnapshot> = {}
    ): RunSnapshot => ({
      runId,
      sessionId,
      status: 'running',
      triggerType,
      parentRunId: triggerType === 'new' ? undefined : parentRunId,
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      pendingOperations: [],
      ...overrides,
    })

    it('should expose lineage fields on every run snapshot', () => {
      expectTypeOf<RunSnapshot>().toHaveProperty('triggerType')
      expectTypeOf<RunSnapshot>().toHaveProperty('parentRunId')
    })

    it('should encode lineage semantics across new and derived runs', () => {
      const fresh = createRunSnapshot('new')
      const derivedSnapshots: RunSnapshot[] = [
        createRunSnapshot('resume', {
          runId: createRunId('run_resume') as RunId,
        }),
        createRunSnapshot('retry', {
          runId: createRunId('run_retry') as RunId,
          status: 'failed',
        }),
        createRunSnapshot('replay', {
          runId: createRunId('run_replay') as RunId,
          status: 'completed',
        }),
      ]

      expect(fresh.triggerType).toBe('new')
      expect(fresh.parentRunId).toBeUndefined()
      expect(derivedSnapshots.map((snapshot) => snapshot.triggerType)).toEqual([
        'resume',
        'retry',
        'replay',
      ])
      expect(derivedSnapshots.every((snapshot) => snapshot.parentRunId === parentRunId)).toBe(true)
    })

    it('should keep trigger-specific fields available after status narrowing', () => {
      const snapshots: RunSnapshot[] = [
        createRunSnapshot('retry', {
          runId: createRunId('run_retry') as RunId,
          status: 'failed',
        }),
        createRunSnapshot('replay', {
          runId: createRunId('run_replay') as RunId,
          status: 'completed',
        }),
      ]

      const terminalSnapshots = snapshots.filter(
        (
          snapshot
        ): snapshot is RunSnapshot & { status: Extract<RunStatus, 'failed' | 'completed'> } =>
          snapshot.status === 'failed' || snapshot.status === 'completed'
      )

      expect(terminalSnapshots.map((snapshot) => snapshot.triggerType)).toEqual(['retry', 'replay'])
      expect(terminalSnapshots.map((snapshot) => snapshot.parentRunId)).toEqual([
        parentRunId,
        parentRunId,
      ])
    })

    it('should preserve lineage fields when optional state is present', () => {
      const snapshot = createRunSnapshot('new', {
        workflowState: { currentNode: 'agent', step: 5 },
        metadata: { attempt: 2 },
      })

      expect(snapshot.triggerType).toBe('new')
      expect(snapshot.parentRunId).toBeUndefined()
      expect((snapshot.workflowState as { currentNode: string }).currentNode).toBe('agent')
      expect(snapshot.metadata?.attempt).toBe(2)
    })
  })
})
