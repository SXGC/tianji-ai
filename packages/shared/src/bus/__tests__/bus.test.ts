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
    const bus = createEventBus({ lagSink: vi.fn(), errorSink: vi.fn() })
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
    const bus = createEventBus({ lagSink: vi.fn(), errorSink: vi.fn() })
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
    const bus = createEventBus({ lagSink: vi.fn(), errorSink: vi.fn() })
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
    const bus = createEventBus({ lagSink: lag, errorSink: vi.fn() })
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
    const bus = createEventBus({ lagSink: vi.fn(), errorSink: vi.fn() })
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

  it('handler throw 调用 errorSink 且不阻断其他订阅者', async () => {
    const errorSink = vi.fn()
    const bus = createEventBus({ lagSink: vi.fn(), errorSink })
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

    // errorSink 被调用，且携带正确 payload
    expect(errorSink).toHaveBeenCalledTimes(1)
    expect(errorSink.mock.calls[0][0]).toMatchObject({
      subscriberName: 'bad',
      envelope: expect.objectContaining({ eventId: 'e1' }),
      error: expect.any(Error),
    })

    // 其他订阅者正常处理
    expect(ok).toEqual(['e1'])
  })

  it('handler throw 后同一订阅者继续处理后续事件', async () => {
    const errorSink = vi.fn()
    const bus = createEventBus({ lagSink: vi.fn(), errorSink })
    const seen: string[] = []

    bus.subscribe(
      {},
      (env) => {
        if (env.eventId === 'e1') throw new Error('first fails')
        seen.push(env.eventId)
      },
      { name: 'flaky' }
    )

    bus.publish(mk({ eventId: 'e1' }))
    bus.publish(mk({ eventId: 'e2' }))
    for (let i = 0; i < 5; i++) await flush()

    // e1 抛出后 e2 仍然被处理
    expect(seen).toEqual(['e2'])
    expect(errorSink).toHaveBeenCalledTimes(1)
  })
})

describe('EventBus.close()', () => {
  it('close() 等待在途 handler 完成后 resolve', async () => {
    const bus = createEventBus({ lagSink: vi.fn(), errorSink: vi.fn() })
    let callCount = 0

    bus.subscribe(
      {},
      async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 30))
        callCount++
      },
      { name: 'slow-handler' }
    )

    // publish 3 条，handler 每条需要 30ms
    bus.publish(mk({ eventId: 'e1' }))
    bus.publish(mk({ eventId: 'e2' }))
    bus.publish(mk({ eventId: 'e3' }))

    // 立即 close，等待所有 handler 跑完
    await bus.close()

    expect(callCount).toBe(3)
  })

  it('close() 后再 publish 抛 Error', async () => {
    const bus = createEventBus({ lagSink: vi.fn(), errorSink: vi.fn() })
    await bus.close()

    expect(() => bus.publish(mk({ eventId: 'e1' }))).toThrow('EventBus is closed')
  })

  it('close() 幂等：多次调用返回同一个 Promise，不报错', async () => {
    const bus = createEventBus({ lagSink: vi.fn(), errorSink: vi.fn() })

    const p1 = bus.close()
    const p2 = bus.close()

    expect(p1).toBe(p2)
    await expect(p1).resolves.toBeUndefined()
  })

  it('close() 排空队列里已 enqueue 的事件，不丢消息', async () => {
    const bus = createEventBus({ lagSink: vi.fn(), errorSink: vi.fn() })
    const processed: string[] = []

    bus.subscribe(
      {},
      async (env) => {
        // 模拟少量延迟，确保 close 在 handler 运行中调用
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
        processed.push(env.eventId)
      },
      { name: 'collector' }
    )

    bus.publish(mk({ eventId: 'e1' }))
    bus.publish(mk({ eventId: 'e2' }))
    bus.publish(mk({ eventId: 'e3' }))
    bus.publish(mk({ eventId: 'e4' }))
    bus.publish(mk({ eventId: 'e5' }))

    await bus.close()

    // 所有 5 条事件必须被处理，不能丢
    expect(processed).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'])
  })
})

describe('createEventBus options contract', () => {
  it('accepts a required errorSink', () => {
    const bus = createEventBus({
      lagSink: () => undefined,
      errorSink: () => undefined,
    })
    expect(typeof bus.publish).toBe('function')
  })

  it('rejects calls that omit errorSink at runtime', () => {
    expect(() => {
      // @ts-expect-error errorSink is required
      createEventBus({ lagSink: () => undefined })
    }).toThrow()
  })
})
