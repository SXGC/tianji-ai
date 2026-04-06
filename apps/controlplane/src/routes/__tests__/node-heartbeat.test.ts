import { createMemorySink, createObserverLogger } from '@tianji/observer'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { createNodeHeartbeatRoute } from '../node-heartbeat.js'
import { createNodeRegisterRoute } from '../node-register.js'

describe('POST /api/nodes/:nodeId/heartbeat', () => {
  let db: ControlPlaneDb
  let accessToken: string

  afterEach(() => {
    db?.close()
  })

  async function setup() {
    db = createDatabase(':memory:')
    db.raw
      .prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)')
      .run('valid-token', Date.now())

    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const app = new Hono()
    app.route('/', createNodeRegisterRoute(db, logger))
    app.route('/', createNodeHeartbeatRoute(db, logger))

    const response = await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-001',
        enrollmentToken: 'valid-token',
        hostname: 'dev',
        platform: 'linux',
        version: '3.0.0',
        agentList: [{ agentId: 'default', type: 'native', name: 'default', version: '3.0.0' }],
      }),
    })

    const data = (await response.json()) as { accessToken: string }
    accessToken = data.accessToken

    return { app, sink }
  }

  it('should accept heartbeat and update last_heartbeat_at', async () => {
    const { app, sink } = await setup()
    const response = await app.request('/api/nodes/node-001/heartbeat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ executionState: 'idle' }),
    })

    expect(response.status).toBe(204)

    const node = db.raw
      .prepare('SELECT last_heartbeat_at, execution_state FROM nodes WHERE node_id = ?')
      .get('node-001') as { last_heartbeat_at: number; execution_state: string }
    expect(node.execution_state).toBe('idle')
    expect(node.last_heartbeat_at).toBeGreaterThan(0)

    expect(
      sink.entries.some((e) => e.level === 'debug' && e.message === 'Heartbeat received')
    ).toBe(true)
  })

  it('should update execution_state to busy', async () => {
    const { app } = await setup()

    await app.request('/api/nodes/node-001/heartbeat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ executionState: 'busy' }),
    })

    const node = db.raw
      .prepare('SELECT execution_state FROM nodes WHERE node_id = ?')
      .get('node-001') as { execution_state: string }
    expect(node.execution_state).toBe('busy')
  })

  it('should reject without auth token', async () => {
    const { app, sink } = await setup()
    const response = await app.request('/api/nodes/node-001/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionState: 'idle' }),
    })

    expect(response.status).toBe(401)
    expect(
      sink.entries.some((e) => e.level === 'warn' && e.message === 'Missing authorization header')
    ).toBe(true)
  })
})
