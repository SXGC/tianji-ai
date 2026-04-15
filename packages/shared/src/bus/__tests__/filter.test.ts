import { describe, expect, it } from 'vitest'
import type { DomainEventEnvelope } from '../../events/envelope.js'
import { matchFilter } from '../filter.js'

function env(overrides: Partial<DomainEventEnvelope>): DomainEventEnvelope {
  return {
    eventId: 'e1',
    type: 'RunStarted',
    occurredAt: '2026-04-14T00:00:00Z',
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

describe('matchFilter', () => {
  it('空 filter 匹配任意 envelope', () => {
    expect(matchFilter({}, env({}))).toBe(true)
  })

  it('aggregateType 列表过滤', () => {
    expect(matchFilter({ aggregateType: ['Run'] }, env({}))).toBe(true)
    expect(matchFilter({ aggregateType: ['Task'] }, env({}))).toBe(false)
  })

  it('aggregateId 精确匹配', () => {
    expect(matchFilter({ aggregateId: 'r1' }, env({}))).toBe(true)
    expect(matchFilter({ aggregateId: 'r2' }, env({}))).toBe(false)
  })

  it('correlationId 精确匹配', () => {
    expect(matchFilter({ correlationId: 'c1' }, env({}))).toBe(true)
    expect(matchFilter({ correlationId: 'c2' }, env({}))).toBe(false)
  })

  it('type 列表过滤', () => {
    expect(matchFilter({ type: ['RunStarted'] }, env({}))).toBe(true)
    expect(matchFilter({ type: ['RunFailed'] }, env({}))).toBe(false)
  })

  it('多条件 AND 组合', () => {
    const ok = env({})
    expect(
      matchFilter({ aggregateType: ['Run'], type: ['RunStarted'], correlationId: 'c1' }, ok)
    ).toBe(true)
    expect(
      matchFilter({ aggregateType: ['Run'], type: ['RunFailed'], correlationId: 'c1' }, ok)
    ).toBe(false)
  })
})
