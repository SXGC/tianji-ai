import type { DomainEventEnvelope } from '@tianji/shared'
// apps/controlplane/src/ingest/__tests__/writer-rules.test.ts
import { describe, expect, it } from 'vitest'
import { validateWriter } from '../writer-rules.js'

function env(overrides: Partial<DomainEventEnvelope>): DomainEventEnvelope {
  return {
    eventId: 'e1',
    type: 'RunStarted',
    occurredAt: 'T',
    correlationId: 'c1',
    causationId: null,
    sequence: 1,
    aggregateType: 'Run',
    aggregateId: 'r1',
    source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
    payload: {} as never,
    ...overrides,
  } as DomainEventEnvelope
}

describe('validateWriter', () => {
  it('Task 只能由 node 发', () => {
    expect(() => validateWriter(env({ aggregateType: 'Task', type: 'TaskStarted' }))).not.toThrow()
    expect(() =>
      validateWriter(
        env({
          aggregateType: 'Task',
          type: 'TaskStarted',
          source: { processKind: 'cp', processId: 'cp1' },
        })
      )
    ).toThrow(/writer/)
  })

  it('TaskObservationLost 例外：只能由 cp 发', () => {
    expect(() =>
      validateWriter(
        env({
          aggregateType: 'Task',
          type: 'TaskObservationLost',
          source: { processKind: 'cp', processId: 'cp1' },
        })
      )
    ).not.toThrow()
    expect(() =>
      validateWriter(
        env({
          aggregateType: 'Task',
          type: 'TaskObservationLost',
          source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
        })
      )
    ).toThrow()
  })

  it('Node 只能由 cp 发', () => {
    expect(() =>
      validateWriter(
        env({
          aggregateType: 'Node',
          type: 'NodeRegistered',
          source: { processKind: 'cp', processId: 'cp1' },
        })
      )
    ).not.toThrow()
    expect(() =>
      validateWriter(
        env({
          aggregateType: 'Node',
          type: 'NodeRegistered',
          source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
        })
      )
    ).toThrow()
  })

  it('Session 只能由 daemon 发', () => {
    expect(() =>
      validateWriter(
        env({
          aggregateType: 'Session',
          type: 'SessionCreated',
          source: { processKind: 'daemon', processId: 'd1' },
        })
      )
    ).not.toThrow()
    expect(() =>
      validateWriter(
        env({
          aggregateType: 'Session',
          type: 'SessionCreated',
          source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
        })
      )
    ).toThrow()
  })

  it('GraphRun / Run 允许 daemon 或 node', () => {
    expect(() =>
      validateWriter(
        env({ aggregateType: 'Run', source: { processKind: 'daemon', processId: 'd' } })
      )
    ).not.toThrow()
    expect(() =>
      validateWriter(
        env({ aggregateType: 'Run', source: { processKind: 'node', processId: 'p', nodeId: 'n' } })
      )
    ).not.toThrow()
    expect(() =>
      validateWriter(env({ aggregateType: 'Run', source: { processKind: 'cp', processId: 'cp' } }))
    ).toThrow()
  })
})
