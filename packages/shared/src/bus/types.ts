/**
 * EventBus 公共类型定义。
 * @module bus/types
 */

import type { AggregateType, DomainEventEnvelope } from '../events/envelope.js'

export interface EventFilter {
  readonly aggregateType?: readonly AggregateType[]
  readonly aggregateId?: string
  readonly correlationId?: string
  readonly type?: readonly string[]
}

export interface SubscriptionHandle {
  unsubscribe(): void
}

export type EventHandler = (env: DomainEventEnvelope) => void | Promise<void>

export interface SubscribeOptions {
  readonly name: string
  readonly queueSize?: number
}

export interface EventBus {
  publish(env: DomainEventEnvelope): void
  subscribe(
    filter: EventFilter,
    handler: EventHandler,
    options: SubscribeOptions
  ): SubscriptionHandle
  /**
   * 优雅关闭 EventBus。
   *
   * 调用后：
   * 1. 标记 bus 为 closed，后续 publish 调用抛出 Error。
   * 2. 等待所有订阅者把队列里已有的 envelope 处理完毕。
   * 3. 取消所有订阅者。
   *
   * 幂等：多次调用返回同一个 Promise。
   */
  close(): Promise<void>
}

export type LagSink = (info: {
  subscriberName: string
  droppedEventId: string
  droppedEventType: string
  queueSize: number
  occurredAt: string
}) => void

export type ErrorSink = (info: {
  subscriberName?: string
  subscriptionId: string
  envelope: DomainEventEnvelope
  error: unknown
}) => void
