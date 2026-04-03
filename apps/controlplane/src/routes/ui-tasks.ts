import { randomUUID } from 'node:crypto'

import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'

type TaskRow = {
  task_id: string
  command_id: string
  node_id: string
  agent_id: string
  goal: string
  status: string
  latest_run_id: string | null
  failure_reason: string | null
  summary: string | null
  created_at: number
  updated_at: number
}

type SessionNodeRow = {
  node_id: string
}

type NodeStatusRow = {
  status: string
}

/**
 * 创建 UI task 路由。
 */
export function createUiTasksRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()

  app.post('/api/ui/tasks', async (c) => {
    const body = (await c.req.json()) as {
      nodeId: string
      agentId: string
      goal: string
      sessionIds?: string[]
    }
    const now = Date.now()
    const node = db.raw.prepare('SELECT status FROM nodes WHERE node_id = ?').get(body.nodeId) as
      | NodeStatusRow
      | undefined

    if (node === undefined) {
      return c.json({ error: 'Node not found' }, 404)
    }
    if (node.status === 'offline') {
      return c.json({ error: 'Node is offline' }, 409)
    }

    if (body.sessionIds !== undefined) {
      for (const sessionId of body.sessionIds) {
        const session = db.raw
          .prepare('SELECT node_id FROM sessions WHERE session_id = ?')
          .get(sessionId) as SessionNodeRow | undefined

        if (session === undefined || session.node_id !== body.nodeId) {
          return c.json(
            { error: `Session ${sessionId} does not belong to node ${body.nodeId}` },
            400
          )
        }
      }
    }

    const taskId = randomUUID()
    const commandId = randomUUID()
    const payload = JSON.stringify({
      taskId,
      agentId: body.agentId,
      goal: body.goal,
      sessionIds: body.sessionIds,
    })

    db.raw
      .prepare(
        `INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
         VALUES (?, ?, 'task.run', ?, 'pending', ?)`
      )
      .run(commandId, body.nodeId, payload, now)
    db.raw
      .prepare(
        `INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(taskId, commandId, body.nodeId, body.agentId, body.goal, now, now)

    return c.json({ taskId, commandId, status: 'pending', createdAt: now }, 201)
  })

  app.get('/api/ui/tasks', (c) => {
    const nodeId = c.req.query('nodeId')
    const status = c.req.query('status')
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 100)
    const cursor = c.req.query('cursor')

    let sql = 'SELECT * FROM tasks WHERE 1=1'
    const params: unknown[] = []

    if (nodeId !== undefined) {
      sql += ' AND node_id = ?'
      params.push(nodeId)
    }
    if (status !== undefined) {
      sql += ' AND status = ?'
      params.push(status)
    }
    if (cursor !== undefined) {
      sql += ' AND task_id > ?'
      params.push(cursor)
    }

    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit + 1)

    const rows = db.raw.prepare(sql).all(...params) as TaskRow[]
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(mapTaskRow)
    const nextCursor = hasMore ? (items[items.length - 1]?.taskId ?? null) : null

    return c.json({ items, nextCursor })
  })

  app.get('/api/ui/tasks/:taskId', (c) => {
    const taskId = c.req.param('taskId')
    if (taskId === undefined) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const row = db.raw.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as
      | TaskRow
      | undefined
    if (row === undefined) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const sessionIds = db.raw
      .prepare('SELECT session_id FROM task_sessions WHERE task_id = ?')
      .all(taskId)
      .map((item) => (item as { session_id: string }).session_id)

    return c.json({
      ...mapTaskRow(row),
      sessionIds,
    })
  })

  return app
}

function mapTaskRow(row: TaskRow) {
  return {
    taskId: row.task_id,
    commandId: row.command_id,
    nodeId: row.node_id,
    agentId: row.agent_id,
    goal: row.goal,
    status: row.status,
    latestRunId: row.latest_run_id,
    failureReason: row.failure_reason,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
