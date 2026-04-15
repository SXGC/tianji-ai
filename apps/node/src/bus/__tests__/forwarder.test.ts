/**
 * Forwarder 测试：验证订阅 bus 并批量 POST 到 cp 的行为。
 * @module bus/__tests__/forwarder.test
 */

import { createEventBus } from '@tianji/shared'
import type { DomainEventEnvelope } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'
import { createForwarder } from '../forwarder.js'

/** 构造一个最小合法 envelope，sequence 可变 */
function makeEnvelope(seq: number): DomainEventEnvelope {
  return {
    eventId: `e${seq}`,
    type: 'RunStarted',
    occurredAt: 'T',
    correlationId: 'c1',
    causationId: null,
    sequence: seq,
    aggregateType: 'Run' as const,
    aggregateId: 'r1',
    source: { processKind: 'node' as const, processId: 'p', nodeId: 'n' },
    payload: {} as never,
  }
}

/** 等待微任务队列清空（flushChain 最多 2 层 .then()，3 次足够） */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('Forwarder', () => {
  it('订阅 bus 并在 maxItems 到达时批量 POST 到 cp', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const bus = createEventBus({ lagSink: vi.fn() })
    const fwd = createForwarder({
      bus,
      post,
      maxItems: 2,
      flushIntervalMs: 1000,
      getCurrentTaskId: () => 't1',
    })

    bus.publish(makeEnvelope(1))
    bus.publish(makeEnvelope(2))

    // 等待 bus 异步派发 + BatchCommitter flush chain 完成
    await flushMicrotasks()
    await flushMicrotasks()

    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0].taskId).toBe('t1')
    expect(post.mock.calls[0][0].events).toHaveLength(2)

    await fwd.dispose()
  })

  it('dispose 时 flush 剩余 buffer', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const bus = createEventBus({ lagSink: vi.fn() })
    const fwd = createForwarder({
      bus,
      post,
      maxItems: 100,
      flushIntervalMs: 60_000,
      getCurrentTaskId: () => 'task-x',
    })

    bus.publish(makeEnvelope(1))
    bus.publish(makeEnvelope(2))
    bus.publish(makeEnvelope(3))

    await flushMicrotasks()
    // 未达 maxItems，还没有触发 flush
    expect(post).not.toHaveBeenCalled()

    await fwd.dispose()
    // dispose 应触发 final flush
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0].events).toHaveLength(3)
  })

  it('原始 envelope correlationId/causationId 不被重写，直接透传', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const bus = createEventBus({ lagSink: vi.fn() })
    const fwd = createForwarder({
      bus,
      post,
      maxItems: 1,
      flushIntervalMs: 60_000,
      getCurrentTaskId: () => 'task-y',
    })

    const env = makeEnvelope(99)
    env.correlationId // 'c1'

    bus.publish(env)
    await flushMicrotasks()
    await flushMicrotasks()

    expect(post).toHaveBeenCalledTimes(1)
    const forwarded = post.mock.calls[0][0].events[0] as DomainEventEnvelope
    // 原始值不被覆盖
    expect(forwarded.correlationId).toBe('c1')
    expect(forwarded.causationId).toBeNull()
    expect(forwarded.eventId).toBe('e99')

    await fwd.dispose()
  })

  it('getCurrentTaskId 返回 null 时 flush 跳过，post 不被调用', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const bus = createEventBus({ lagSink: vi.fn() })
    const fwd = createForwarder({
      bus,
      post,
      maxItems: 1,
      flushIntervalMs: 60_000,
      // 始终返回 null，模拟无任务执行中
      getCurrentTaskId: () => null,
    })

    bus.publish(makeEnvelope(1))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(post).not.toHaveBeenCalled()

    await fwd.dispose()
    // dispose 也应跳过
    expect(post).not.toHaveBeenCalled()
  })
})
