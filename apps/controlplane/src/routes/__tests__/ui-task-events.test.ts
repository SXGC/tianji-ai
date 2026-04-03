import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { EventStore } from '../../services/event-store.js'
import { createUiTaskEventsRoute } from '../ui-task-events.js'

describe('GET /api/ui/tasks/:taskId/events', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    const now = Date.now()

    db.raw.prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)').run('t', now)
    db.raw
      .prepare(
        `INSERT INTO nodes (
          node_id, hostname, platform, version, access_token_hash, access_token_expires_at, enrollment_token, created_at, updated_at
        ) VALUES ('n1', 'h', 'linux', '1', 'h', 999999999999999, 't', ?, ?)`
      )
      .run(now, now)
    db.raw
      .prepare(
        `INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
         VALUES ('cmd-1', 'n1', 'task.run', '{}', 'leased', ?)`
      )
      .run(now)
    db.raw
      .prepare(
        `INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
         VALUES ('task-1', 'cmd-1', 'n1', 'default', 'test', 'running', ?, ?)`
      )
      .run(now, now)

    const store = new EventStore(db)
    store.insertEvent('task-1', 1, 'lifecycle', '{"type":"task.started"}')
    store.insertEvent('task-1', 2, 'agent', '{"type":"message.delta"}')
    store.insertEvent('task-1', 3, 'agent', '{"type":"tool.started"}')

    const app = new Hono()
    app.route('/', createUiTaskEventsRoute(db))
    return app
  }

  it('should return all events after sequence 0', async () => {
    const app = setup()
    const response = await app.request('/api/ui/tasks/task-1/events?after=0&limit=200')
    expect(response.status).toBe(200)

    const data = (await response.json()) as { items: unknown[]; nextSequence: number }
    expect(data.items).toHaveLength(3)
    expect(data.nextSequence).toBe(4)
  })

  it('should return events after given sequence', async () => {
    const app = setup()
    const response = await app.request('/api/ui/tasks/task-1/events?after=1&limit=200')

    const data = (await response.json()) as { items: Array<{ sequence: number }> }
    expect(data.items).toHaveLength(2)
    expect(data.items[0]!.sequence).toBe(2)
  })

  it('should respect limit', async () => {
    const app = setup()
    const response = await app.request('/api/ui/tasks/task-1/events?after=0&limit=1')

    const data = (await response.json()) as { items: unknown[] }
    expect(data.items).toHaveLength(1)
  })
})
