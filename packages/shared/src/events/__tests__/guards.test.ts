import { describe, expect, it } from 'vitest'
import type { DomainEventEnvelope } from '../envelope.js'
import { isGraphRunEvent, isNodeEvent, isRunEvent, isSessionEvent, isTaskEvent } from '../guards.js'

function envelope(type: string, aggregateType: string): DomainEventEnvelope {
  return {
    eventId: 'evt_1',
    type,
    occurredAt: '2026-04-14T00:00:00Z',
    correlationId: 'corr_1',
    causationId: null,
    sequence: 1,
    aggregateType: aggregateType as never,
    aggregateId: 'agg_1',
    source: { processKind: 'daemon', processId: 'p1' },
    payload: {} as never,
  } as DomainEventEnvelope
}

describe('event guards', () => {
  it('按 aggregateType 区分事件', () => {
    expect(isSessionEvent(envelope('SessionCreated', 'Session'))).toBe(true)
    expect(isGraphRunEvent(envelope('GraphRunStarted', 'GraphRun'))).toBe(true)
    expect(isRunEvent(envelope('RunStarted', 'Run'))).toBe(true)
    expect(isTaskEvent(envelope('TaskStarted', 'Task'))).toBe(true)
    expect(isNodeEvent(envelope('NodeRegistered', 'Node'))).toBe(true)
  })

  it('aggregateType 不匹配返回 false', () => {
    expect(isSessionEvent(envelope('RunStarted', 'Run'))).toBe(false)
  })
})
