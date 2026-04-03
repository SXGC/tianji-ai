import { isTerminalTaskStatus } from '@tianji/shared'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

import type { ControlPlaneDb } from '../db/index.js'
import { EventStore } from '../services/event-store.js'

/**
 * 创建 task SSE 推送路由。
 */
export function createTaskStreamRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()
  const eventStore = new EventStore(db)

  app.get('/api/ui/tasks/:taskId/stream', (c) => {
    const taskId = c.req.param('taskId')
    if (taskId === undefined) {
      return c.json({ error: 'Task not found' }, 404)
    }

    const lastEventId = c.req.header('Last-Event-ID') ?? ''
    let lastSequence = 0
    if (lastEventId.includes(':')) {
      lastSequence = Number(lastEventId.split(':')[1]) || 0
    }

    return streamSSE(c, async (stream) => {
      const events = eventStore.getEvents(taskId, lastSequence, 1000)

      for (const event of events) {
        const sseEventType =
          event.kind === 'lifecycle'
            ? 'task.lifecycle'
            : `agent.${extractAgentEventType(event.payload)}`

        await stream.writeSSE({
          event: sseEventType,
          data: JSON.stringify({
            sequence: event.sequence,
            kind: event.kind,
            payload: JSON.parse(event.payload),
            receivedAt: event.receivedAt,
          }),
          id: `${taskId}:${event.sequence}`,
        })

        lastSequence = event.sequence
      }

      const task = db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId) as
        | { status: string }
        | undefined

      if (task !== undefined && isTerminalTaskStatus(task.status as never)) {
        await stream.writeSSE({ event: 'done', data: '{}' })
      }
    })
  })

  return app
}

function extractAgentEventType(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { type?: string }
    return parsed.type ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
