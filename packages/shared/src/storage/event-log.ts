/**
 * EventLogStore 接口：领域事件日志持久化抽象。
 * 实现侧在各 app 内落地（cp 用 sqlite）。
 * @module storage/event-log
 */

import type { AggregateType, DomainEventEnvelope } from '../events/envelope.js'

export interface EventLogAppendResult {
  readonly written: number
}

export interface EventLogStore {
  append(events: readonly DomainEventEnvelope[]): Promise<EventLogAppendResult>
  maxSequence(aggregateType: AggregateType, aggregateId: string): Promise<number | null>
  queryByAggregate(
    aggregateType: AggregateType,
    aggregateId: string,
    fromSequence?: number
  ): AsyncIterable<DomainEventEnvelope>
  queryByCorrelation(
    correlationId: string,
    fromSequence?: number
  ): AsyncIterable<DomainEventEnvelope>
}
