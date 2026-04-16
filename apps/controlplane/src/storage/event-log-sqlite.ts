/**
 * event_log 的 better-sqlite3 实现。
 * append 内部用同步事务执行，但返回 Promise 以贴合 EventLogStore 接口。
 * rowToEnvelope 使用 zod 做运行时类型验证，消除 as 强转带来的类型漏洞。
 * @module storage/event-log-sqlite
 */

import type {
  AggregateType,
  DomainEventEnvelope,
  EventLogAppendResult,
  EventLogStore,
} from '@tianji/shared'
import type Database from 'better-sqlite3'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// zod schema：验证从 SQLite 读取的行数据，避免类型强转掩盖漂移
// ---------------------------------------------------------------------------

const aggregateTypeSchema = z.enum(['Session', 'GraphRun', 'Run', 'Task', 'Node'])

const envelopeSourceSchema = z.object({
  processKind: z.enum(['daemon', 'node', 'cp']),
  processId: z.string(),
  nodeId: z.string().optional(),
})

/** SQLite 原始行结构（all 方法返回 unknown，先窄化为此类型再验证）。 */
const rowSchema = z.object({
  event_id: z.string(),
  type: z.string(),
  occurred_at: z.string(),
  correlation_id: z.string(),
  causation_id: z.string().nullable(),
  sequence: z.number(),
  aggregate_type: aggregateTypeSchema,
  aggregate_id: z.string(),
  source_json: z.string(),
  payload_json: z.string(),
})

type ValidatedRow = z.infer<typeof rowSchema>

/**
 * 将已验证的 SQLite 行转换为 DomainEventEnvelope。
 *
 * - `source` 通过 zod 做运行时结构验证，消除 JSON.parse 返回 any 的类型漏洞。
 * - `aggregate_type` 由 rowSchema 的 z.enum 保证合法性。
 * - `type`（事件类型字符串）和 `payload` 来自受控写入路径，运行时可信；
 *   TypeScript 无法在编译时验证反序列化的字符串 union，故仍需 as 转换。
 */
function rowToEnvelope(row: ValidatedRow): DomainEventEnvelope {
  const source = envelopeSourceSchema.parse(JSON.parse(row.source_json))
  return {
    eventId: row.event_id,
    type: row.type,
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    sequence: row.sequence,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    source,
    // payload 结构由受控写入路径保证，此处只做 JSON 反序列化
    payload: JSON.parse(row.payload_json) as DomainEventEnvelope['payload'],
  } as DomainEventEnvelope
}

export class SqliteEventLogStore implements EventLogStore {
  private readonly insertStmt: Database.Statement
  private readonly existsByEventIdStmt: Database.Statement
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
    this.existsByEventIdStmt = db.prepare('SELECT 1 FROM event_log WHERE event_id = ? LIMIT 1')
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
      let written = 0
      for (const e of items) {
        const existing = this.existsByEventIdStmt.get(e.eventId) as { 1: number } | undefined
        if (existing !== undefined) {
          continue
        }
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
        written += 1
      }
      return written
    })
    return { written: tx(events) }
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
    const rows = this.byAggStmt.all(aggregateType, aggregateId, fromSequence)
    for (const raw of rows) {
      yield rowToEnvelope(rowSchema.parse(raw))
    }
  }

  async *queryByCorrelation(
    correlationId: string,
    fromSequence = 1
  ): AsyncIterable<DomainEventEnvelope> {
    const rows = this.byCorrStmt.all(correlationId, fromSequence)
    for (const raw of rows) {
      yield rowToEnvelope(rowSchema.parse(raw))
    }
  }
}
