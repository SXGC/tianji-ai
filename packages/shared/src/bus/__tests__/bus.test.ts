import { describe, expect, it, vi } from 'vitest'
import type { DomainEventEnvelope } from '../../events/envelope.js'
import { createEventBus } from '../bus.js'

function mk(overrides: Partial<DomainEventEnvelope>): DomainEventEnvelope {
  return {
    eventId: overrides.eventId ?? 'e?',
    type: overrides.type ?? 'RunStarted',
    occurredAt: '2026-04-14T00:00:00Z',
    correlationId: overrides.correlationId ?? 'c1',
    causationId: null,
    sequence: overrides.sequence ?? 1,
    aggregateType: overrides.aggregateType ?? 'Run',
    aggregateId: overrides.aggregateId ?? 'r1',
    source: { processKind: 'node', processId: 'p1' },
    payload: {} as never,
  } as DomainEventEnvelope
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()))

describe('EventBus', () => {
  it('publish 同步返回，handler 异步执行', async () => {
    const bus = createEventBus({ lagSink: vi.fn() })
    const seen: string[] = []
    bus.subscribe(
      {},
      (env) => {
        seen.push(env.eventId)
      },
      { name: 's1' }
    )
    bus.publish(mk({ eventId: 'e1' }))
    expect(seen).toEqual([])
    await flush()
    expect(seen).toEqual(['e1'])
  })

  it('按 filter 投递', async () => {
    const bus = createEventBus({ lagSink: vi.fn() })
    const taskSeen: string[] = []
    bus.subscribe(
      { aggregateType: ['Task'] },
      (env) => {
        taskSeen.push(env.eventId)
      },
      { name: 'task-sub' }
    )
    bus.publish(mk({ eventId: 'e1', aggregateType: 'Run' }))
    bus.publish(mk({ eventId: 'e2', aggregateType: 'Task', aggregateId: 't1' }))
    await flush()
    await flush()
    expect(taskSeen).toEqual(['e2'])
  })

  it('订阅者顺序执行 handler', async () => {
    const bus = createEventBus({ lagSink: vi.fn() })
    const order: string[] = []
    bus.subscribe(
      {},
      async (env) => {
        order.push(`in:${env.eventId}`)
        await Promise.resolve()
        order.push(`out:${env.eventId}`)
      },
      { name: 's1' }
    )
    bus.publish(mk({ eventId: 'e1' }))
    bus.publish(mk({ eventId: 'e2' }))
    for (let i = 0; i < 5; i++) await flush()
    expect(order).toEqual(['in:e1', 'out:e1', 'in:e2', 'out:e2'])
  })

  it('队列满丢弃并调用 lagSink', async () => {
    const lag = vi.fn()
    const bus = createEventBus({ lagSink: lag })
    bus.subscribe(
      {},
      async () => {
        await new Promise((r) => setTimeout(r, 10))
      },
      { name: 'slow', queueSize: 2 }
    )
    bus.publish(mk({ eventId: 'e1' }))
    bus.publish(mk({ eventId: 'e2' }))
    bus.publish(mk({ eventId: 'e3' }))
    expect(lag).toHaveBeenCalledTimes(1)
    expect(lag.mock.calls[0][0]).toMatchObject({ subscriberName: 'slow', droppedEventId: 'e3' })
  })

  it('unsubscribe 后不再投递', async () => {
    const bus = createEventBus({ lagSink: vi.fn() })
    const seen: string[] = []
    const sub = bus.subscribe(
      {},
      (env) => {
        seen.push(env.eventId)
      },
      { name: 's1' }
    )
    sub.unsubscribe()
    bus.publish(mk({ eventId: 'e1' }))
    await flush()
    expect(seen).toEqual([])
  })

  it('handler throw 不阻断其他订阅者', async () => {
    const bus = createEventBus({ lagSink: vi.fn() })
    const err = vi.fn()
    const ok: string[] = []
    bus.subscribe(
      {},
      () => {
        throw new Error('boom')
      },
      { name: 'bad' }
    )
    bus.subscribe(
      {},
      (env) => {
        ok.push(env.eventId)
      },
      { name: 'good' }
    )
    bus.publish(mk({ eventId: 'e1' }))
    await flush()
    await flush()
    expect(ok).toEqual(['e1'])
    void err
  })
})
