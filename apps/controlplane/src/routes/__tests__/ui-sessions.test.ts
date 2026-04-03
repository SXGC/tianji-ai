import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { createUiSessionsRoute } from '../ui-sessions.js'

describe('UI Sessions API', () => {
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
    app.route('/', createUiSessionsRoute(db))
    return app
  }

  it('POST /api/ui/sessions should create session metadata', async () => {
    const app = setup()
    const response = await app.request('/api/ui/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', agentId: 'default', title: 'test session' }),
    })

    expect(response.status).toBe(201)

    const data = (await response.json()) as { sessionId: string; nodeId: string }
    expect(data.sessionId).toBeDefined()
    expect(data.nodeId).toBe('n1')
  })

  it('GET /api/ui/sessions should list sessions', async () => {
    const app = setup()

    await app.request('/api/ui/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', agentId: 'default' }),
    })

    const response = await app.request('/api/ui/sessions?nodeId=n1')
    expect(response.status).toBe(200)

    const data = (await response.json()) as { items: unknown[] }
    expect(data.items).toHaveLength(1)
  })

  it('GET /api/ui/sessions/:sessionId should return session details', async () => {
    const app = setup()
    const createResponse = await app.request('/api/ui/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', agentId: 'default', title: 'test' }),
    })
    const { sessionId } = (await createResponse.json()) as { sessionId: string }

    const response = await app.request(`/api/ui/sessions/${sessionId}`)
    expect(response.status).toBe(200)

    const data = (await response.json()) as { sessionId: string }
    expect(data.sessionId).toBe(sessionId)
  })
})
