/**
 * 进程内薄 pub/sub EventBus。
 * publish 同步返回；每订阅者独立有界队列；队列满丢事件并发 lagSink。
 * handler 抛出异常时通过 errorSink 记录，不中断订阅者队列。
 * @module bus/bus
 */

import type { DomainEventEnvelope } from '../events/envelope.js'
import { matchFilter } from './filter.js'
import type {
  ErrorSink,
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
  /**
   * 当前正在运行的 drain Promise（含后续排队的所有 envelope）。
   * close() 通过 await 它来等待该订阅者完全排空。
   * drain 结束后重置为 null。
   */
  drainPromise: Promise<void> | null
}

const DEFAULT_QUEUE_SIZE = 1024

export interface EventBusOptions {
  readonly lagSink: LagSink
  /**
   * 订阅者 handler 抛出异常时调用，用于记录可观测日志。
   * 必填：禁止 bus 在失败路径上默默走 console，所有调用方必须显式指定可观测出口。
   * 不得 rethrow，异常隔离是 bus 的核心不变量。
   */
  readonly errorSink: ErrorSink
}

/** 创建一个进程内 EventBus 实例。 */
export function createEventBus(options: EventBusOptions): EventBus {
  if (typeof options.errorSink !== 'function') {
    throw new TypeError('createEventBus: errorSink is required')
  }
  if (typeof options.lagSink !== 'function') {
    throw new TypeError('createEventBus: lagSink is required')
  }
  const subscribers = new Map<number, Subscriber>()
  let nextId = 1
  let closed = false
  /** close() 调用后存储唯一的 drain-all Promise，实现幂等 */
  let closePromise: Promise<void> | null = null

  function publish(env: DomainEventEnvelope): void {
    if (closed) {
      throw new Error('EventBus is closed')
    }
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
    // 用链式 Promise 串联：新的 drain 等前一个 drain 完再开始
    // 这样 drainPromise 始终代表"该订阅者所有已排队 envelope 处理完毕"
    const prev = sub.drainPromise ?? Promise.resolve()
    const next = prev.then(() => drain(sub))
    sub.drainPromise = next
    queueMicrotask(() => {
      void next
    })
  }

  const errorSink = options.errorSink

  async function drain(sub: Subscriber): Promise<void> {
    while (!sub.cancelled && sub.queue.length > 0) {
      const env = sub.queue.shift() as DomainEventEnvelope
      try {
        await sub.handler(env)
      } catch (error) {
        errorSink({
          subscriberName: sub.name,
          subscriptionId: String(sub.id),
          envelope: env,
          error,
        })
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
      drainPromise: null,
    }
    subscribers.set(id, sub)
    return {
      unsubscribe(): void {
        sub.cancelled = true
        subscribers.delete(id)
      },
    }
  }

  /**
   * 优雅关闭 EventBus。
   *
   * 标记 closed，等待所有订阅者队列排空，然后取消所有订阅者。
   * 幂等：多次调用返回同一个 Promise。
   */
  function close(): Promise<void> {
    if (closePromise !== null) return closePromise

    closed = true

    closePromise = (async () => {
      // snapshot 所有订阅者当前的 drainPromise
      // drainPromise 是链式串联的，await 它等价于"该订阅者所有已入队 envelope 处理完"
      const pending = [...subscribers.values()]
        .map((sub) => sub.drainPromise)
        .filter((p): p is Promise<void> => p !== null)
      await Promise.all(pending)

      // unsubscribe 所有订阅者
      for (const sub of subscribers.values()) {
        sub.cancelled = true
      }
      subscribers.clear()
    })()

    return closePromise
  }

  return { publish, subscribe, close }
}
