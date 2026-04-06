import type { ObserverLogger } from '@tianji/observer'
import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { createAuthMiddleware } from '../middleware/auth.js'
import { EventStore } from '../services/event-store.js'

type AuthVariables = {
  Variables: {
    nodeId: string
  }
}

/**
 * 创建 task 事件接收路由。
 *
 * @param db - controlplane 数据库实例
 * @param logger - 结构化日志实例
 */
export function createTaskEventsRoute(
  db: ControlPlaneDb,
  logger: ObserverLogger
): Hono<AuthVariables> {
  const app = new Hono<AuthVariables>()
  const auth = createAuthMiddleware(db, logger)
  const eventStore = new EventStore(db)

  app.post('/api/tasks/:taskId/events', auth, async (c) => {
    const taskId = c.req.param('taskId')
    if (taskId === undefined) {
      return c.json({ error: 'Missing task ID' }, 400)
    }

    const body = c.req.raw.body
    if (body === null) {
      return c.json({ accepted: 0 })
    }

    let accepted = 0
    const tid = taskId

    /** 处理单行 NDJSON 数据，入库并更新任务状态。 */
    function processLine(line: string): void {
      accepted++
      try {
        const event = JSON.parse(line) as {
          kind: string
          sequence: number
          type?: string
          summary?: string
          error?: string
          sessionId?: string
        }

        eventStore.insertEvent(tid, event.sequence, event.kind, line)

        if (event.kind === 'lifecycle' && event.type !== undefined) {
          updateTaskFromLifecycle(db, tid, {
            type: event.type,
            summary: event.summary,
            error: event.error,
            sessionId: event.sessionId,
          })
        }
      } catch {
        // 跳过不合法的 NDJSON 行。
      }
    }

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (value !== undefined) {
        buffer += decoder.decode(value, { stream: !done })
      }

      // 逐行处理已到达的 NDJSON 数据。
      for (
        let newlineIdx = buffer.indexOf('\n');
        newlineIdx !== -1;
        newlineIdx = buffer.indexOf('\n')
      ) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (line.length > 0) {
          processLine(line)
        }
      }

      if (done) {
        break
      }
    }

    // 处理末尾无换行的残留数据。
    const trailing = buffer.trim()
    if (trailing.length > 0) {
      processLine(trailing)
    }

    return c.json({ accepted })
  })

  return app
}

function updateTaskFromLifecycle(
  db: ControlPlaneDb,
  taskId: string,
  event: { type: string; summary?: string; error?: string; sessionId?: string }
): void {
  const now = Date.now()

  switch (event.type) {
    case 'task.started':
      db.raw
        .prepare('UPDATE tasks SET status = ?, summary = ?, updated_at = ? WHERE task_id = ?')
        .run('running', event.summary ?? null, now, taskId)
      break
    case 'task.waiting':
      db.raw
        .prepare('UPDATE tasks SET status = ?, summary = ?, updated_at = ? WHERE task_id = ?')
        .run('waiting', event.summary ?? null, now, taskId)
      break
    case 'task.completed':
      db.raw
        .prepare('UPDATE tasks SET status = ?, summary = ?, updated_at = ? WHERE task_id = ?')
        .run('completed', event.summary ?? null, now, taskId)
      db.raw
        .prepare(
          'UPDATE commands SET state = ?, completed_at = ? WHERE command_id = (SELECT command_id FROM tasks WHERE task_id = ?)'
        )
        .run('completed', now, taskId)
      break
    case 'task.failed':
      db.raw
        .prepare(
          'UPDATE tasks SET status = ?, failure_reason = ?, updated_at = ? WHERE task_id = ?'
        )
        .run('failed', event.error ?? 'agent_error', now, taskId)
      db.raw
        .prepare(
          'UPDATE commands SET state = ?, completed_at = ? WHERE command_id = (SELECT command_id FROM tasks WHERE task_id = ?)'
        )
        .run('failed', now, taskId)
      break
    case 'task.cancelled':
      db.raw
        .prepare(
          'UPDATE tasks SET status = ?, failure_reason = ?, updated_at = ? WHERE task_id = ?'
        )
        .run('cancelled', 'cancelled_by_user', now, taskId)
      db.raw
        .prepare(
          'UPDATE commands SET state = ?, completed_at = ? WHERE command_id = (SELECT command_id FROM tasks WHERE task_id = ?)'
        )
        .run('failed', now, taskId)
      break
    case 'task.session.attached':
      if (event.sessionId !== undefined) {
        db.raw
          .prepare(
            `INSERT OR IGNORE INTO task_sessions (task_id, session_id, attached_at, attached_by)
             VALUES (?, ?, ?, 'agent')`
          )
          .run(taskId, event.sessionId, now)
      }
      break
  }
}
