import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { createUiTasksRoute } from '../ui-tasks.js'

describe('UI Tasks API', () => {
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
          node_id, hostname, platform, version, status, access_token_hash, access_token_expires_at, enrollment_token, last_heartbeat_at, created_at, updated_at
        ) VALUES ('n1', 'h', 'linux', '1', 'online', 'hash', 999999999999999, 't', ?, ?, ?)`
      )
      .run(now, now, now)

    const app = new Hono()
    app.route('/', createUiTasksRoute(db))
    return app
  }

  it('POST /api/ui/tasks should create task and command', async () => {
    const app = setup()
    const response = await app.request('/api/ui/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', agentId: 'default', goal: 'test' }),
    })

    expect(response.status).toBe(201)

    const data = (await response.json()) as { taskId: string; status: string }
    expect(data.taskId).toBeDefined()
    expect(data.status).toBe('pending')
  })

  it('POST /api/ui/tasks should reject offline node', async () => {
    const app = setup()
    db.raw.prepare('UPDATE nodes SET status = ? WHERE node_id = ?').run('offline', 'n1')

    const response = await app.request('/api/ui/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', agentId: 'default', goal: 'test' }),
    })

    expect(response.status).toBe(409)
  })

  it('GET /api/ui/tasks should list tasks', async () => {
    const app = setup()

    await app.request('/api/ui/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', agentId: 'default', goal: 'test' }),
    })

    const response = await app.request('/api/ui/tasks')
    expect(response.status).toBe(200)

    const data = (await response.json()) as { items: unknown[] }
    expect(data.items).toHaveLength(1)
  })

  it('GET /api/ui/tasks/:taskId should return 404 for unknown task', async () => {
    const app = setup()
    const response = await app.request('/api/ui/tasks/nonexistent')

    expect(response.status).toBe(404)
  })
})
