/**
 * event_log 的 better-sqlite3 实现。
 * append 内部用同步事务执行，但返回 Promise 以贴合 EventLogStore 接口。
 * @module storage/event-log-sqlite
 */

import type {
  AggregateType,
  DomainEventEnvelope,
  EventLogAppendResult,
  EventLogStore,
} from '@tianji/shared'
import type Database from 'better-sqlite3'

interface Row {
  event_id: string
  type: string
  occurred_at: string
  correlation_id: string
  causation_id: string | null
  sequence: number
  aggregate_type: string
  aggregate_id: string
  source_json: string
  payload_json: string
}

function rowToEnvelope(row: Row): DomainEventEnvelope {
  return {
    eventId: row.event_id,
    type: row.type,
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    sequence: row.sequence,
    aggregateType: row.aggregate_type as AggregateType,
    aggregateId: row.aggregate_id,
    source: JSON.parse(row.source_json),
    payload: JSON.parse(row.payload_json),
  } as DomainEventEnvelope
}

export class SqliteEventLogStore implements EventLogStore {
  private readonly insertStmt: Database.Statement
  private readonly maxStmt: Database.Statement
  private readonly byAggStmt: Database.Statement
  private readonly byCorrStmt: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO event_log
        (event_id, type, occurred_at, correlation_id, causation_id,
         sequence, aggregate_type, aggregate_id, source_json, payload_json)
      VALUES
        (@event_id, @type, @occurred_at, @correlation_id, @causation_id,
         @sequence, @aggregate_type, @aggregate_id, @source_json, @payload_json)
    `)
    this.maxStmt = db.prepare(
      'SELECT MAX(sequence) as max_seq FROM event_log WHERE aggregate_type = ? AND aggregate_id = ?'
    )
    this.byAggStmt = db.prepare(
      'SELECT * FROM event_log WHERE aggregate_type = ? AND aggregate_id = ? AND sequence >= ? ORDER BY sequence ASC'
    )
    this.byCorrStmt = db.prepare(
      'SELECT * FROM event_log WHERE correlation_id = ? AND sequence >= ? ORDER BY occurred_at ASC, sequence ASC'
    )
  }

  async append(events: readonly DomainEventEnvelope[]): Promise<EventLogAppendResult> {
    if (events.length === 0) return { written: 0 }
    const tx = this.db.transaction((items: readonly DomainEventEnvelope[]) => {
      for (const e of items) {
        this.insertStmt.run({
          event_id: e.eventId,
          type: e.type,
          occurred_at: e.occurredAt,
          correlation_id: e.correlationId,
          causation_id: e.causationId,
          sequence: e.sequence,
          aggregate_type: e.aggregateType,
          aggregate_id: e.aggregateId,
          source_json: JSON.stringify(e.source),
          payload_json: JSON.stringify(e.payload),
        })
      }
    })
    tx(events)
    return { written: events.length }
  }

  async maxSequence(aggregateType: AggregateType, aggregateId: string): Promise<number | null> {
    const row = this.maxStmt.get(aggregateType, aggregateId) as
      | { max_seq: number | null }
      | undefined
    return row?.max_seq ?? null
  }

  async *queryByAggregate(
    aggregateType: AggregateType,
    aggregateId: string,
    fromSequence = 1
  ): AsyncIterable<DomainEventEnvelope> {
    const rows = this.byAggStmt.all(aggregateType, aggregateId, fromSequence) as Row[]
    for (const row of rows) yield rowToEnvelope(row)
  }

  async *queryByCorrelation(
    correlationId: string,
    fromSequence = 1
  ): AsyncIterable<DomainEventEnvelope> {
    const rows = this.byCorrStmt.all(correlationId, fromSequence) as Row[]
    for (const row of rows) yield rowToEnvelope(row)
  }
}
