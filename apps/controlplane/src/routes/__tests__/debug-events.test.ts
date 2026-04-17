import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { SCHEMA_SQL } from '../../db/schema.js'
import { createDebugEventsRoute } from '../debug-events.js'

interface RawEvent {
  eventId: string
  type: string
  occurredAt: string
  correlationId: string
  causationId: string | null
  sequence: number
  aggregateType: 'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node'
  aggregateId: string
  source: { processKind: 'daemon' | 'node' | 'cp'; processId: string }
  payload: Record<string, unknown>
}

function setupDb() {
  const raw = new Database(':memory:')
  raw.exec(SCHEMA_SQL)
  const db = { raw } as unknown as { raw: Database.Database }
  return { raw, db }
}

function insertEvent(raw: Database.Database, ev: RawEvent): void {
  raw
    .prepare(
      `INSERT INTO event_log
       (event_id, type, occurred_at, correlation_id, causation_id, sequence,
        aggregate_type, aggregate_id, source_json, payload_json)
       VALUES (@e, @t, @o, @c, @ca, @s, @at, @ai, @src, @pl)`
    )
    .run({
      e: ev.eventId,
      t: ev.type,
      o: ev.occurredAt,
      c: ev.correlationId,
      ca: ev.causationId,
      s: ev.sequence,
      at: ev.aggregateType,
      ai: ev.aggregateId,
      src: JSON.stringify(ev.source),
      pl: JSON.stringify(ev.payload),
    })
}

function makeEv(overrides: Partial<RawEvent> & Pick<RawEvent, 'eventId' | 'sequence'>): RawEvent {
  return {
    type: 'RunStarted',
    occurredAt: new Date().toISOString(),
    correlationId: 'c-1',
    causationId: null,
    aggregateType: 'Run',
    aggregateId: 'run-1',
    source: { processKind: 'daemon', processId: 'p-1' },
    payload: {},
    ...overrides,
  }
}

describe('GET /api/debug/events realtime', () => {
  test('bootstrap 请求返回最近 100 条并按 rowid 降序', async () => {
    const { raw, db } = setupDb()
    for (let i = 1; i <= 150; i++) {
      insertEvent(raw, makeEv({ eventId: `e-${i}`, sequence: i }))
    }
    const app = createDebugEventsRoute(db as never)
    const res = await app.request('/api/debug/events?mode=realtime')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      events: Array<{ eventId: string; cursor: number }>
      maxCursor: number
      minCursor: number
      hasMore: boolean
    }
    expect(body.events).toHaveLength(100)
    expect(body.events[0]!.cursor).toBe(150)
    expect(body.events.at(-1)!.cursor).toBe(51)
    expect(body.maxCursor).toBe(150)
    expect(body.minCursor).toBe(51)
  })
})

describe('GET /api/debug/events realtime 增量', () => {
  test('since_cursor=N 只返回 rowid > N 的事件', async () => {
    const { raw, db } = setupDb()
    for (let i = 1; i <= 5; i++) {
      insertEvent(raw, makeEv({ eventId: `e-${i}`, sequence: i }))
    }
    const app = createDebugEventsRoute(db as never)
    const res = await app.request('/api/debug/events?mode=realtime&since_cursor=3')
    const body = (await res.json()) as { events: Array<{ cursor: number }> }
    expect(body.events.map((e) => e.cursor)).toEqual([5, 4])
  })

  test('跨聚合体的事件不会被游标跳过', async () => {
    const { raw, db } = setupDb()
    insertEvent(raw, makeEv({ eventId: 'a1', sequence: 1, aggregateId: 'A' }))
    insertEvent(raw, makeEv({ eventId: 'b1', sequence: 1, aggregateId: 'B' }))
    const app = createDebugEventsRoute(db as never)
    const res = await app.request('/api/debug/events?mode=realtime')
    const body = (await res.json()) as { events: Array<{ eventId: string }> }
    expect(body.events.map((e) => e.eventId).sort()).toEqual(['a1', 'b1'])
  })
})

describe('GET /api/debug/events 硬编码过滤', () => {
  test('MessageDelta 与 TaskMessageDelta 不会返回', async () => {
    const { raw, db } = setupDb()
    insertEvent(raw, makeEv({ eventId: 'd1', sequence: 1, type: 'MessageDelta' }))
    insertEvent(raw, makeEv({ eventId: 't1', sequence: 2, type: 'TaskMessageDelta' }))
    insertEvent(raw, makeEv({ eventId: 'r1', sequence: 3, type: 'RunStarted' }))
    const app = createDebugEventsRoute(db as never)
    const res = await app.request('/api/debug/events?mode=realtime')
    const body = (await res.json()) as { events: Array<{ type: string }> }
    expect(body.events.map((e) => e.type)).toEqual(['RunStarted'])
  })
})

describe('GET /api/debug/events history', () => {
  test('按时间范围过滤并支持 before_cursor 分页', async () => {
    const { raw, db } = setupDb()
    for (let i = 1; i <= 10; i++) {
      insertEvent(
        raw,
        makeEv({
          eventId: `e-${i}`,
          sequence: i,
          occurredAt: new Date(1_000_000 + i * 1000).toISOString(),
        })
      )
    }
    const app = createDebugEventsRoute(db as never)
    const firstRes = await app.request(
      '/api/debug/events?mode=history&start_time=1970-01-01T00:16:42.000Z&end_time=1970-01-01T00:16:49.000Z&limit=5'
    )
    const first = (await firstRes.json()) as {
      events: Array<{ cursor: number }>
      hasMore: boolean
      minCursor: number
    }
    expect(first.events.map((e) => e.cursor)).toEqual([9, 8, 7, 6, 5])
    expect(first.hasMore).toBe(true)
    expect(first.minCursor).toBe(5)
    const nextRes = await app.request(
      `/api/debug/events?mode=history&start_time=1970-01-01T00:16:42.000Z&end_time=1970-01-01T00:16:49.000Z&limit=5&before_cursor=${first.minCursor}`
    )
    const next = (await nextRes.json()) as { events: Array<{ cursor: number }>; hasMore: boolean }
    expect(next.events.map((e) => e.cursor)).toEqual([4, 3, 2])
    expect(next.hasMore).toBe(false)
  })
})

describe('GET /api/debug/events 参数校验', () => {
  test('缺失 mode 返回 400', async () => {
    const { db } = setupDb()
    const app = createDebugEventsRoute(db as never)
    const res = await app.request('/api/debug/events')
    expect(res.status).toBe(400)
  })

  test('since_cursor=0 返回 400（游标必须为正整数）', async () => {
    const { db } = setupDb()
    const app = createDebugEventsRoute(db as never)
    const res = await app.request('/api/debug/events?mode=realtime&since_cursor=0')
    expect(res.status).toBe(400)
  })

  test('limit 超过 500 会被截断到 500（非 400 拒绝）', async () => {
    const { raw, db } = setupDb()
    for (let i = 1; i <= 600; i++) {
      insertEvent(raw, makeEv({ eventId: `e-${i}`, sequence: i }))
    }
    const app = createDebugEventsRoute(db as never)
    const res = await app.request('/api/debug/events?mode=realtime&limit=1000')
    const body = (await res.json()) as { events: unknown[] }
    expect(body.events.length).toBe(500)
  })

  test('用户显式 limit 小于默认值时不被覆盖', async () => {
    const { raw, db } = setupDb()
    for (let i = 1; i <= 50; i++) {
      insertEvent(raw, makeEv({ eventId: `e-${i}`, sequence: i }))
    }
    const app = createDebugEventsRoute(db as never)
    const res = await app.request('/api/debug/events?mode=realtime&limit=30')
    const body = (await res.json()) as { events: unknown[] }
    expect(body.events.length).toBe(30)
  })
})
