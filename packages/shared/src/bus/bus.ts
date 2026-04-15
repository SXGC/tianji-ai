/**
 * 进程内薄 pub/sub EventBus。
 * publish 同步返回；每订阅者独立有界队列；队列满丢事件并发 lagSink。
 * replay 留给调用方注入 store-backed 实现（阶段 05）。
 * @module bus/bus
 */

import type { DomainEventEnvelope } from '../events/envelope.js'
import { matchFilter } from './filter.js'
import type {
  EventBus,
  EventFilter,
  EventHandler,
  LagSink,
  SubscribeOptions,
  SubscriptionHandle,
} from './types.js'

interface Subscriber {
  readonly id: number
  readonly name: string
  readonly filter: EventFilter
  readonly handler: EventHandler
  readonly queueSize: number
  readonly queue: DomainEventEnvelope[]
  running: boolean
  cancelled: boolean
}

const DEFAULT_QUEUE_SIZE = 1024

export interface EventBusOptions {
  readonly lagSink: LagSink
  readonly replaySource?: (
    filter: EventFilter,
    fromSequence?: number
  ) => AsyncIterable<DomainEventEnvelope>
}

/** 创建一个进程内 EventBus 实例。 */
export function createEventBus(options: EventBusOptions): EventBus {
  const subscribers = new Map<number, Subscriber>()
  let nextId = 1

  function publish(env: DomainEventEnvelope): void {
    for (const sub of subscribers.values()) {
      if (sub.cancelled) continue
      if (!matchFilter(sub.filter, env)) continue
      if (sub.queue.length >= sub.queueSize) {
        options.lagSink({
          subscriberName: sub.name,
          droppedEventId: env.eventId,
          droppedEventType: env.type,
          queueSize: sub.queueSize,
          occurredAt: env.occurredAt,
        })
        continue
      }
      sub.queue.push(env)
      schedule(sub)
    }
  }

  function schedule(sub: Subscriber): void {
    if (sub.running) return
    sub.running = true
    queueMicrotask(() => {
      void drain(sub)
    })
  }

  async function drain(sub: Subscriber): Promise<void> {
    while (!sub.cancelled && sub.queue.length > 0) {
      const env = sub.queue.shift() as DomainEventEnvelope
      try {
        await sub.handler(env)
      } catch {
        // handler 异常吞掉，不中断订阅者；由 handler 自身负责 error 日志
      }
    }
    sub.running = false
  }

  function subscribe(
    filter: EventFilter,
    handler: EventHandler,
    opts: SubscribeOptions
  ): SubscriptionHandle {
    const id = nextId++
    const sub: Subscriber = {
      id,
      name: opts.name,
      filter,
      handler,
      queueSize: opts.queueSize ?? DEFAULT_QUEUE_SIZE,
      queue: [],
      running: false,
      cancelled: false,
    }
    subscribers.set(id, sub)
    return {
      unsubscribe(): void {
        sub.cancelled = true
        subscribers.delete(id)
      },
    }
  }

  async function* replay(
    filter: EventFilter,
    fromSequence?: number
  ): AsyncIterable<DomainEventEnvelope> {
    if (!options.replaySource) {
      throw new Error('EventBus.replay: 未配置 replaySource')
    }
    for await (const env of options.replaySource(filter, fromSequence)) {
      yield env
    }
  }

  return { publish, subscribe, replay }
}
