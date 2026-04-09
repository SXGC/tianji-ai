import { describe, expect, expectTypeOf, it } from 'vitest'
import type { RunId } from '../identifiers.js'
import { createRunId, createSessionId } from '../identifiers.js'
import type { RunSnapshot, RunStatus, RunTriggerType, TokenUsage } from '../snapshot.js'
import { addTokenUsage } from '../snapshot.js'

describe('TokenUsage', () => {
  it('is structurally compatible with expected shape', () => {
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    }

    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(50)
    expect(usage.totalTokens).toBe(150)
  })

  it('accepts optional cache token fields', () => {
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      cacheReadTokens: 800,
      cacheCreationTokens: 100,
    }

    expect(usage.cacheReadTokens).toBe(800)
    expect(usage.cacheCreationTokens).toBe(100)
  })

  it('allows omitting cache token fields for backward compatibility', () => {
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    }

    expect(usage.cacheReadTokens).toBeUndefined()
    expect(usage.cacheCreationTokens).toBeUndefined()
  })
})

describe('addTokenUsage', () => {
  it('sums two TokenUsage records', () => {
    const base: TokenUsage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
    const delta: TokenUsage = { inputTokens: 200, outputTokens: 100, totalTokens: 300 }

    expect(addTokenUsage(base, delta)).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
    })
  })

  it('treats undefined base as zero', () => {
    const delta: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }

    expect(addTokenUsage(undefined, delta)).toEqual(delta)
  })

  it('sums cache token fields when both sides have them', () => {
    const base: TokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 80,
      cacheCreationTokens: 10,
    }
    const delta: TokenUsage = {
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      cacheReadTokens: 150,
      cacheCreationTokens: 20,
    }

    expect(addTokenUsage(base, delta)).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
      cacheReadTokens: 230,
      cacheCreationTokens: 30,
    })
  })

  it('carries cache token fields from delta when base has none', () => {
    const base: TokenUsage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
    const delta: TokenUsage = {
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      cacheReadTokens: 150,
      cacheCreationTokens: 20,
    }

    expect(addTokenUsage(base, delta)).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
      cacheReadTokens: 150,
      cacheCreationTokens: 20,
    })
  })

  it('omits cache token fields when neither side has them', () => {
    const base: TokenUsage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
    const delta: TokenUsage = { inputTokens: 200, outputTokens: 100, totalTokens: 300 }

    const result = addTokenUsage(base, delta)
    expect(result.cacheReadTokens).toBeUndefined()
    expect(result.cacheCreationTokens).toBeUndefined()
  })
})

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
