import { randomUUID } from 'node:crypto'

import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'

type NodeStatusRow = {
  status: string
}

type SessionRow = {
  session_id: string
  node_id: string
  agent_id: string
  title: string | null
  last_run_id: string | null
  created_at: number
  updated_at: number
}

type CreateSessionBody = {
  nodeId: string
  agentId: string
  title?: string
}

/**
 * 创建 UI session 路由。
 */
export function createUiSessionsRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()

  app.post('/api/ui/sessions', async (c) => {
    const body = (await c.req.json()) as CreateSessionBody // NOSONAR

    const node = db.raw.prepare('SELECT status FROM nodes WHERE node_id = ?').get(body.nodeId) as
      | NodeStatusRow
      | undefined

    if (node === undefined) {
      return c.json({ error: 'Node not found' }, 404)
    }
    if (node.status === 'offline') {
      return c.json({ error: 'Node is offline' }, 409)
    }

    const sessionId = randomUUID()
    const now = Date.now()

    db.raw
      .prepare(
        `INSERT INTO sessions (session_id, node_id, agent_id, title, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'user', ?, ?)`
      )
      .run(sessionId, body.nodeId, body.agentId, body.title ?? null, now, now)

    return c.json(
      {
        sessionId,
        nodeId: body.nodeId,
        agentId: body.agentId,
        createdAt: now,
      },
      201
    )
  })

  app.get('/api/ui/sessions', (c) => {
    const nodeId = c.req.query('nodeId')
    const agentId = c.req.query('agentId')
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 100)
    const cursor = c.req.query('cursor')

    let sql = 'SELECT * FROM sessions WHERE 1=1'
    const params: unknown[] = []

    if (nodeId !== undefined) {
      sql += ' AND node_id = ?'
      params.push(nodeId)
    }
    if (agentId !== undefined) {
      sql += ' AND agent_id = ?'
      params.push(agentId)
    }
    if (cursor !== undefined) {
      sql += ' AND session_id > ?'
      params.push(cursor)
    }

    sql += ' ORDER BY updated_at DESC LIMIT ?'
    params.push(limit + 1)

    const rows = db.raw.prepare(sql).all(...params) as SessionRow[]
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => ({
      sessionId: row.session_id,
      nodeId: row.node_id,
      agentId: row.agent_id,
      title: row.title,
      lastRunId: row.last_run_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
    const nextCursor = hasMore ? (items.at(-1)?.sessionId ?? null) : null

    return c.json({ items, nextCursor })
  })

  app.get('/api/ui/sessions/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId')
    if (sessionId === undefined) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const row = db.raw.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as
      | SessionRow
      | undefined
    if (row === undefined) {
      return c.json({ error: 'Session not found' }, 404)
    }

    const linkedTaskIds = db.raw
      .prepare('SELECT task_id FROM task_sessions WHERE session_id = ?')
      .all(sessionId)
      .map((item) => (item as { task_id: string }).task_id)

    return c.json({
      sessionId: row.session_id,
      nodeId: row.node_id,
      agentId: row.agent_id,
      title: row.title,
      linkedTaskIds,
      lastRunId: row.last_run_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  })

  return app
}
