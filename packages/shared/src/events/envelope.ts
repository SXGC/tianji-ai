/**
 * 统一跨聚合、跨进程的领域事件信封定义。
 * @module events/envelope
 */

import type { DomainEvent } from './domain-event.js'

export type AggregateType = 'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node'

export type ProcessKind = 'daemon' | 'node' | 'cp'

export interface EnvelopeSource {
  readonly processKind: ProcessKind
  readonly processId: string
  readonly nodeId?: string
}

export interface DomainEventEnvelope<T extends DomainEvent = DomainEvent> {
  readonly eventId: string
  readonly type: T['type']
  readonly occurredAt: string
  readonly correlationId: string
  readonly causationId: string | null
  readonly sequence: number
  readonly aggregateType: AggregateType
  readonly aggregateId: string
  readonly source: EnvelopeSource
  readonly payload: T
}
