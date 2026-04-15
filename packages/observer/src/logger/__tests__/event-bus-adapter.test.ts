import type { DomainEventEnvelope } from '@tianji/shared'
import { createEventBus } from '@tianji/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { formatEnvelopeLog, subscribeEventBusLogger } from '../event-bus-adapter.js'
import { createMemorySink, createObserverLogger } from '../index.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

const flush = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()))

/**
 * 构造最小 DomainEventEnvelope。
 * payload.type 与 envelope.type 保持一致。
 */
function mkEnvelope(type: string, extra: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope {
  return {
    eventId: 'evt-001',
    type,
    occurredAt: '2026-04-14T00:00:00.000Z',
    correlationId: 'corr-abc',
    causationId: 'cause-xyz',
    sequence: 3,
    aggregateType: 'Run',
    aggregateId: 'run-001',
    source: { processKind: 'node', processId: 'pid-1' },
    payload: { type, runId: 'run-001', timestamp: 0 },
    ...extra,
  } as unknown as DomainEventEnvelope
}

// ─── formatEnvelopeLog ────────────────────────────────────────────────────────

describe('formatEnvelopeLog', () => {
  it('把 envelope 公共字段全部映射到 data', () => {
    const env = mkEnvelope('RunStarted')
    const { data } = formatEnvelopeLog(env)

    expect(data.correlationId).toBe('corr-abc')
    expect(data.causationId).toBe('cause-xyz')
    expect(data.sequence).toBe(3)
    expect(data.aggregateType).toBe('Run')
    expect(data.aggregateId).toBe('run-001')
  })

  it('payload 字段保留在 data.payload 中', () => {
    const env = mkEnvelope('ToolStarted')
    const { data } = formatEnvelopeLog(env)

    expect(data.payload).toEqual(env.payload)
  })

  it('causationId 为 null 时仍写入 data（值为 null）', () => {
    const env = mkEnvelope('RunCompleted', { causationId: null })
    const { data } = formatEnvelopeLog(env)

    expect('causationId' in data).toBe(true)
    expect(data.causationId).toBeNull()
  })

  it('message 为 envelope.type', () => {
    const env = mkEnvelope('RunFailed')
    const { message } = formatEnvelopeLog(env)

    expect(message).toBe('RunFailed')
  })

  it('scope 固定为 [observer, event-bus]', () => {
    const env = mkEnvelope('MessageDelta')
    const { scope } = formatEnvelopeLog(env)

    expect(scope).toEqual(['observer', 'event-bus'])
  })
})

// ─── subscribeEventBusLogger — 单元测试 ────────────────────────────────────

describe('subscribeEventBusLogger — 写入 ObserverLogger', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('每收到一个 envelope 写入一条 trace 日志，data 包含 correlationId', async () => {
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const bus = createEventBus({ lagSink: vi.fn() })

    const handle = subscribeEventBusLogger(bus, logger)

    bus.publish(mkEnvelope('RunStarted'))
    await flush()

    expect(sink.entries).toHaveLength(1)
    const entry = sink.entries[0]
    expect(entry?.data?.correlationId).toBe('corr-abc')
    expect(entry?.data?.aggregateType).toBe('Run')
    expect(entry?.data?.sequence).toBe(3)

    handle.unsubscribe()
  })

  it('filter 为全聚合：任意类型事件均被投递', async () => {
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const bus = createEventBus({ lagSink: vi.fn() })

    const handle = subscribeEventBusLogger(bus, logger)

    // bus.drain 是 async handler 链，每条事件需单独 flush 确保 handler 完成
    bus.publish(mkEnvelope('MessageDelta'))
    await flush()
    bus.publish(mkEnvelope('TaskStarted'))
    await flush()
    bus.publish(mkEnvelope('GraphRunStarted'))
    await flush()

    expect(sink.entries).toHaveLength(3)

    handle.unsubscribe()
  })

  it('unsubscribe 后事件不再写入日志', async () => {
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const bus = createEventBus({ lagSink: vi.fn() })

    const handle = subscribeEventBusLogger(bus, logger)
    handle.unsubscribe()

    bus.publish(mkEnvelope('RunCompleted'))
    await flush()

    expect(sink.entries).toHaveLength(0)
  })

  it('payload 字段写入 data.payload，保持原始结构', async () => {
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const bus = createEventBus({ lagSink: vi.fn() })

    const handle = subscribeEventBusLogger(bus, logger)

    const env = mkEnvelope('ToolCompleted')
    bus.publish(env)
    await flush()

    expect(sink.entries[0]?.data?.payload).toEqual(env.payload)

    handle.unsubscribe()
  })

  it('日志 level 为 trace', async () => {
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const bus = createEventBus({ lagSink: vi.fn() })

    const handle = subscribeEventBusLogger(bus, logger)

    bus.publish(mkEnvelope('RunStarted'))
    await flush()

    expect(sink.entries[0]?.level).toBe('trace')

    handle.unsubscribe()
  })
})
