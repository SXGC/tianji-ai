/**
 * Bus 订阅者：把 envelope 喂给 BatchCommitter，再落到 EventLogStore。
 * @module storage/event-log-subscriber
 */

import type {
  DomainEventEnvelope,
  EventBus,
  EventLogStore,
  SubscriptionHandle,
} from '@tianji/shared'
import { BatchCommitter } from './batch-committer.js'

export interface EventLogSubscriberOptions {
  readonly maxItems?: number
  readonly flushIntervalMs?: number
}

/**
 * 订阅总线全量事件并批量写入 EventLogStore。
 *
 * @param bus - 进程内 EventBus
 * @param store - EventLogStore 持久化实现
 * @param options - 批量提交参数（默认 maxItems=500, flushIntervalMs=50）
 */
export function subscribeEventLog(
  bus: EventBus,
  store: EventLogStore,
  options: EventLogSubscriberOptions = {}
): { subscription: SubscriptionHandle; committer: BatchCommitter<DomainEventEnvelope> } {
  const committer = new BatchCommitter<DomainEventEnvelope>({
    maxItems: options.maxItems ?? 500,
    flushIntervalMs: options.flushIntervalMs ?? 50,
    flush: async (batch) => {
      await store.append(batch)
    },
  })
  const subscription = bus.subscribe(
    {},
    (env) => {
      committer.push(env)
    },
    { name: 'event-log-subscriber', queueSize: 10_000 }
  )
  return { subscription, committer }
}
