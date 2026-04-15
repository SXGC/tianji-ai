/**
 * EventBus 公共类型定义。
 * @module bus/types
 */

import type { DomainEvent } from '../events/domain-event.js'
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
  replay(filter: EventFilter, fromSequence?: number): AsyncIterable<DomainEventEnvelope>
}

export type LagSink = (info: {
  subscriberName: string
  droppedEventId: string
  droppedEventType: string
  queueSize: number
  occurredAt: string
}) => void

export type _UnusedDomainEvent = DomainEvent
