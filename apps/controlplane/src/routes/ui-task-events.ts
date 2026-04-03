import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { EventStore } from '../services/event-store.js'

/**
 * 创建 UI task 事件历史路由。
 */
export function createUiTaskEventsRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()
  const eventStore = new EventStore(db)

  app.get('/api/ui/tasks/:taskId/events', (c) => {
    const taskId = c.req.param('taskId')
    if (taskId === undefined) {
      return c.json({ items: [], nextSequence: 1, truncated: false })
    }

    const after = Number(c.req.query('after') ?? 0)
    const limit = Math.min(Number(c.req.query('limit') ?? 200), 1000)
    const events = eventStore.getEvents(taskId, after, limit)
    const firstStoredSequence = db.raw
      .prepare('SELECT MIN(sequence) as minSeq FROM task_events WHERE task_id = ?')
      .get(taskId) as { minSeq: number | null } | undefined

    const truncated = firstStoredSequence?.minSeq !== null && (firstStoredSequence?.minSeq ?? 0) > 1
    const items = events.map((event) => ({
      sequence: event.sequence,
      kind: event.kind,
      payload: JSON.parse(event.payload),
      receivedAt: event.receivedAt,
    }))
    const nextSequence = events.length > 0 ? events[events.length - 1]!.sequence + 1 : after + 1

    return c.json({ items, nextSequence, truncated })
  })

  return app
}
