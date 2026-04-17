/**
 * Bus 订阅者：把 envelope 喂给 BatchCommitter，再落到 EventLogStore。
 *
 * 返回单一 `close()` 函数，调用顺序保证：
 * 1. 先 unsubscribe，阻止新事件到达
 * 2. await committer.dispose()（含最终 flush）
 * @module storage/event-log-subscriber
 */

import { errorToLogData } from '@tianji/observer'
import type { ObserverLogger } from '@tianji/observer'
import type { DomainEventEnvelope, ErrorSink, EventBus, EventLogStore } from '@tianji/shared'
import {
  BatchCommitter,
  buildEventDiagnosticFields,
  shouldLogEventDiagnostics,
} from '@tianji/shared'

export interface EventLogSubscriberOptions {
  readonly maxItems?: number
  readonly flushIntervalMs?: number
  /**
   * 将 flush 错误路由到总线 errorSink，实现错误可观测性。
   * 若不传，flush 错误仅会被记录到日志。
   */
  readonly errorSink?: ErrorSink
  /**
   * 结构化日志实例，用于 error 级别日志输出。
   */
  readonly logger?: ObserverLogger
}

export interface EventLogSubscriberHandle {
  /** 停止订阅并 await 最终 flush，保证所有待写入事件落盘。 */
  close(): Promise<void>
}

/**
 * 订阅总线全量事件并批量写入 EventLogStore。
 *
 * @param bus - 进程内 EventBus
 * @param store - EventLogStore 持久化实现
 * @param options - 批量提交参数与错误路由配置
 */
export function subscribeEventLog(
  bus: EventBus,
  store: EventLogStore,
  options: EventLogSubscriberOptions = {}
): EventLogSubscriberHandle {
  const { errorSink, logger } = options

  const committer = new BatchCommitter<DomainEventEnvelope>({
    maxItems: options.maxItems ?? 500,
    flushIntervalMs: options.flushIntervalMs ?? 50,
    flush: async (batch) => {
      await store.append(batch)
    },
    onFlushError: (err, items) => {
      const first = items[0]
      const diagnostics =
        first !== undefined && shouldLogEventDiagnostics(first)
          ? buildEventDiagnosticFields(first)
          : undefined
      // 使用 error 级别日志保证错误可见性
      void logger?.error(['event-log-subscriber', 'flush'], 'batch flush failed', {
        itemCount: items.length,
        ...errorToLogData(err),
        ...diagnostics,
      })
      // 若配置了 errorSink，通知第一条 envelope（代表该批次）
      if (errorSink && items.length > 0) {
        errorSink({
          subscriberName: 'event-log-subscriber',
          subscriptionId: 'event-log-subscriber',
          envelope: items[0],
          error: err,
        })
      }
    },
  })

  const subscription = bus.subscribe(
    {},
    (env) => {
      try {
        committer.push(env)
      } catch (err) {
        // committer 已 disposed 或其他异常：路由到 errorSink 并记录日志
        void logger?.error(
          ['event-log-subscriber', 'push'],
          'failed to push envelope to committer',
          {
            eventId: env.eventId,
            ...errorToLogData(err),
          }
        )
        if (errorSink) {
          errorSink({
            subscriberName: 'event-log-subscriber',
            subscriptionId: 'event-log-subscriber',
            envelope: env,
            error: err,
          })
        }
      }
    },
    { name: 'event-log-subscriber', queueSize: 10_000 }
  )

  return {
    async close(): Promise<void> {
      // 先 unsubscribe，确保不再有新事件推入 committer
      subscription.unsubscribe()
      // 再 dispose committer（await inFlight + final flush）
      await committer.dispose()
    },
  }
}
