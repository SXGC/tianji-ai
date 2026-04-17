/**
 * event-log-subscriber 集成测试。
 * 覆盖：bus → subscriber → committer → SQLite in-memory 全链路。
 */

import { createMemorySink, createObserverLogger } from '@tianji/observer'
import type { DomainEventEnvelope, ErrorSink } from '@tianji/shared'
import { createEventBus } from '@tianji/shared'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_SQL } from '../../db/schema.js'
import { SqliteEventLogStore } from '../event-log-sqlite.js'
import { subscribeEventLog } from '../event-log-subscriber.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)
  return db
}

function makeEnv(seq: number, overrides: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope {
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

/** 等待所有 microtask 和 macrotask 落定（bus 队列 + committer 计时器）。 */
async function drain(ms = 100): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const lagSink = vi.fn()

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('subscribeEventLog', () => {
  afterEach(() => {
    lagSink.mockClear()
  })

  it('Bus 发布事件 → subscriber → 落入 SQLite（端到端）', async () => {
    const db = freshDb()
    const store = new SqliteEventLogStore(db)
    const bus = createEventBus({ lagSink, errorSink: () => undefined })

    const handle = subscribeEventLog(bus, store, { flushIntervalMs: 10 })

    bus.publish(makeEnv(1))
    bus.publish(makeEnv(2))
    bus.publish(makeEnv(3))

    // 等待 bus 微任务 + committer flush 定时器
    await drain(50)
    await handle.close()

    expect(await store.maxSequence('Run', 'r1')).toBe(3)
  })

  it('close() 在返回前 flush 所有剩余事件', async () => {
    const db = freshDb()
    const store = new SqliteEventLogStore(db)
    // 使用极长 flushIntervalMs，保证定时器不会自动触发
    const bus = createEventBus({ lagSink, errorSink: () => undefined })
    const handle = subscribeEventLog(bus, store, { flushIntervalMs: 60_000 })

    bus.publish(makeEnv(1))
    bus.publish(makeEnv(2))

    // 等待 bus microtask 把事件推入 committer buffer
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
    // 此时 flush 定时器还没触发，buffer 中有 2 条
    await handle.close()

    // close() 应保证 final flush 完成
    expect(await store.maxSequence('Run', 'r1')).toBe(2)
  })

  it('flush 失败时路由到 errorSink', async () => {
    const flushError = new Error('db write failed')
    const store: InstanceType<typeof SqliteEventLogStore> = {
      append: vi.fn().mockRejectedValue(flushError),
      maxSequence: vi.fn(),
      queryByAggregate: vi.fn(),
      queryByCorrelation: vi.fn(),
    } as never

    const errorSink: ErrorSink = vi.fn()
    const bus = createEventBus({ lagSink, errorSink: () => undefined })
    const handle = subscribeEventLog(bus, store, {
      flushIntervalMs: 10,
      errorSink,
    })

    bus.publish(makeEnv(1))
    await drain(50)
    await handle.close().catch(() => {
      // final flush 也可能失败，忽略
    })

    expect(errorSink).toHaveBeenCalled()
    const call = (errorSink as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.error).toBe(flushError)
    expect(call.envelope.eventId).toBe('e1')
  })

  it('非 MessageDelta 的 flush 失败会记录诊断字段', async () => {
    const flushError = new Error('db write failed')
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const store: InstanceType<typeof SqliteEventLogStore> = {
      append: vi.fn().mockRejectedValue(flushError),
      maxSequence: vi.fn(),
      queryByAggregate: vi.fn(),
      queryByCorrelation: vi.fn(),
    } as never

    const bus = createEventBus({ lagSink, errorSink: () => undefined })
    const handle = subscribeEventLog(bus, store, {
      flushIntervalMs: 10,
      logger,
    })

    bus.publish(makeEnv(5, { eventId: 'flush-diag' }))
    await drain(50)
    await handle.close().catch(() => {})

    const flushEntry = sink.entries.find((item) => item.message === 'batch flush failed')
    expect(flushEntry).toBeDefined()
    expect(flushEntry?.data).toMatchObject({
      eventId: 'flush-diag',
      eventType: 'RunStarted',
      aggregateType: 'Run',
      aggregateId: 'r1',
      sequence: 5,
      itemCount: 1,
    })
    // errorToLogData 展开后应包含 name / message / stack
    expect(flushEntry?.data).toMatchObject({
      name: expect.any(String),
      message: 'db write failed',
    })
    expect(typeof (flushEntry?.data as Record<string, unknown>)?.stack).toBe('string')
  })

  it('MessageDelta 的 flush 失败不记录诊断字段', async () => {
    const flushError = new Error('db write failed')
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const store: InstanceType<typeof SqliteEventLogStore> = {
      append: vi.fn().mockRejectedValue(flushError),
      maxSequence: vi.fn(),
      queryByAggregate: vi.fn(),
      queryByCorrelation: vi.fn(),
    } as never

    const bus = createEventBus({ lagSink, errorSink: () => undefined })
    const handle = subscribeEventLog(bus, store, {
      flushIntervalMs: 10,
      logger,
    })

    bus.publish(
      makeEnv(6, {
        eventId: 'flush-message-delta',
        type: 'MessageDelta',
        payload: { type: 'MessageDelta', content: 'x' } as never,
      })
    )
    await drain(50)
    await handle.close().catch(() => {})

    const entry = sink.entries.find((item) => item.message === 'batch flush failed')
    expect(entry?.data).not.toMatchObject({ eventId: 'flush-message-delta' })
  })

  it('close() 调用后不再处理新事件', async () => {
    const db = freshDb()
    const store = new SqliteEventLogStore(db)
    const bus = createEventBus({ lagSink, errorSink: () => undefined })
    const handle = subscribeEventLog(bus, store, { flushIntervalMs: 10 })

    bus.publish(makeEnv(1))
    await drain(50)
    await handle.close()

    // close 之后再 publish 不应出现 unhandled rejection 或写入
    bus.publish(makeEnv(2))
    await drain(50)

    // 只有第一条写入，第二条因 unsubscribe 不再接收
    expect(await store.maxSequence('Run', 'r1')).toBe(1)
  })
})
