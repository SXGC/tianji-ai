import type { DomainEventEnvelope } from '@tianji/shared'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { SCHEMA_SQL } from '../../db/schema.js'
import { SqliteEventLogStore } from '../event-log-sqlite.js'

function freshDb() {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)
  return db
}

function env(seq: number, overrides: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope {
  return {
    eventId: `e${seq}`,
    type: 'RunStarted',
    occurredAt: `2026-04-14T00:00:${String(seq).padStart(2, '0')}Z`,
    correlationId: 'c1',
    causationId: null,
    sequence: seq,
    aggregateType: 'Run',
    aggregateId: 'r1',
    source: { processKind: 'node', processId: 'p1' },
    payload: { type: 'RunStarted' } as never,
    ...overrides,
  } as DomainEventEnvelope
}

describe('SqliteEventLogStore', () => {
  it('append 写入后 maxSequence 返回最大值', async () => {
    const store = new SqliteEventLogStore(freshDb())
    await store.append([env(1), env(2), env(3)])
    expect(await store.maxSequence('Run', 'r1')).toBe(3)
    expect(await store.maxSequence('Run', 'rX')).toBeNull()
  })

  it('UNIQUE(aggregate_type, aggregate_id, sequence) 冲突直接 throw', async () => {
    const store = new SqliteEventLogStore(freshDb())
    await store.append([env(1)])
    await expect(store.append([env(1, { eventId: 'e1b' })])).rejects.toThrow()
  })

  it('queryByAggregate 按 fromSequence 过滤', async () => {
    const store = new SqliteEventLogStore(freshDb())
    await store.append([env(1), env(2), env(3)])
    const out: number[] = []
    for await (const e of store.queryByAggregate('Run', 'r1', 2)) out.push(e.sequence)
    expect(out).toEqual([2, 3])
  })

  it('queryByCorrelation 跨聚合按 sequence 排序', async () => {
    const store = new SqliteEventLogStore(freshDb())
    await store.append([
      env(1, { aggregateId: 'r1', sequence: 1, correlationId: 'c1' }),
      env(1, { aggregateId: 'r2', sequence: 1, correlationId: 'c1', eventId: 'eX' }),
      env(2, { aggregateId: 'r1', sequence: 2, correlationId: 'c1', eventId: 'eY' }),
    ])
    const out: string[] = []
    for await (const e of store.queryByCorrelation('c1')) out.push(e.eventId)
    expect(out.length).toBe(3)
  })
})
