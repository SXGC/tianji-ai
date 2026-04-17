import { Hono } from 'hono'
import { z } from 'zod'

import type { ControlPlaneDb } from '../db/index.js'

const EXCLUDED_TYPES = ['MessageDelta', 'TaskMessageDelta'] as const

const querySchema = z.object({
  mode: z.enum(['realtime', 'history']),
  since_cursor: z.coerce.number().int().positive().optional(),
  before_cursor: z.coerce.number().int().positive().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  aggregate_type: z.enum(['Session', 'GraphRun', 'Run', 'Task', 'Node']).optional(),
  aggregate_id: z.string().optional(),
  // 上限在 handler 中用 Math.min 夹到 500（而非 .max(500) 拒绝），保持对前端的宽松语义。
  limit: z.coerce.number().int().positive().optional(),
})

const MAX_LIMIT = 500
const BOOTSTRAP_DEFAULT_LIMIT = 100
const HISTORY_DEFAULT_LIMIT = 200

interface RawRow {
  rowid: number
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

function rowToEnvelope(row: RawRow): Record<string, unknown> {
  return {
    eventId: row.event_id,
    type: row.type,
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    sequence: row.sequence,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    source: JSON.parse(row.source_json) as unknown,
    payload: JSON.parse(row.payload_json) as unknown,
    cursor: row.rowid,
  }
}

/**
 * Debug 专用：查询 event_log，支持实时（rowid > since_cursor）与历史（rowid < before_cursor +
 * occurred_at 范围）两种模式。永远按 rowid 降序返回；硬编码排除 MessageDelta / TaskMessageDelta。
 */
export function createDebugEventsRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()

  app.get('/api/debug/events', (c) => {
    const parsed = querySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams.entries())
    )
    if (!parsed.success) {
      return c.json({ error: 'invalid query params' }, 400)
    }
    const q = parsed.data

    const where: string[] = ['type NOT IN (?, ?)']
    const params: Array<string | number> = [...EXCLUDED_TYPES]

    // bootstrap：realtime 且未传 since_cursor 时，默认 100 条；否则默认 200 条。
    // 用户显式传入的 limit 只做上限夹（≤ MAX_LIMIT=500），不覆盖用户意图。
    const isBootstrap = q.mode === 'realtime' && q.since_cursor === undefined
    const defaultLimit = isBootstrap ? BOOTSTRAP_DEFAULT_LIMIT : HISTORY_DEFAULT_LIMIT
    const effectiveLimit = Math.min(q.limit ?? defaultLimit, MAX_LIMIT)

    if (q.mode === 'realtime') {
      if (q.since_cursor !== undefined) {
        where.push('rowid > ?')
        params.push(q.since_cursor)
      }
    } else {
      if (q.before_cursor !== undefined) {
        where.push('rowid < ?')
        params.push(q.before_cursor)
      }
      if (q.start_time !== undefined) {
        where.push('occurred_at >= ?')
        params.push(q.start_time)
      }
      if (q.end_time !== undefined) {
        where.push('occurred_at <= ?')
        params.push(q.end_time)
      }
    }

    if (q.aggregate_type !== undefined) {
      where.push('aggregate_type = ?')
      params.push(q.aggregate_type)
    }
    if (q.aggregate_id !== undefined) {
      where.push('aggregate_id = ?')
      params.push(q.aggregate_id)
    }

    const sql = `SELECT rowid, * FROM event_log WHERE ${where.join(' AND ')}
                 ORDER BY rowid DESC LIMIT ?`
    params.push(effectiveLimit)
    const rows = db.raw.prepare(sql).all(...params) as RawRow[]
    const events = rows.map(rowToEnvelope)

    const hasMore = q.mode === 'history' && rows.length === effectiveLimit
    const maxCursor = rows[0]?.rowid ?? 0
    const minCursor = rows.at(-1)?.rowid ?? 0

    return c.json({ events, maxCursor, minCursor, hasMore })
  })

  return app
}
