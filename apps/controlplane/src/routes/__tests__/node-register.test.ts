import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { createNodeRegisterRoute } from '../node-register.js'

describe('POST /api/nodes/register', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    db.raw
      .prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)')
      .run('valid-token', Date.now())

    const app = new Hono()
    app.route('/', createNodeRegisterRoute(db))

    return app
  }

  it('should register a new node and return access token', async () => {
    const app = setup()
    const response = await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-001',
        enrollmentToken: 'valid-token',
        hostname: 'dev-machine',
        platform: 'linux',
        version: '3.0.0',
        agentList: [{ agentId: 'default', type: 'native', name: 'default', version: '3.0.0' }],
      }),
    })

    expect(response.status).toBe(200)

    const data = (await response.json()) as { accessToken: string; expiresAt: number }
    expect(data.accessToken).toBeDefined()
    expect(data.expiresAt).toBeGreaterThan(Date.now())
  })

  it('should reject invalid enrollment token', async () => {
    const app = setup()
    const response = await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-002',
        enrollmentToken: 'invalid-token',
        hostname: 'dev-machine',
        platform: 'linux',
        version: '3.0.0',
        agentList: [],
      }),
    })

    expect(response.status).toBe(403)
  })

  it('should re-register existing node with new access token', async () => {
    const app = setup()

    await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-001',
        enrollmentToken: 'valid-token',
        hostname: 'dev-1',
        platform: 'linux',
        version: '3.0.0',
        agentList: [],
      }),
    })

    const response = await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-001',
        enrollmentToken: 'valid-token',
        hostname: 'dev-1-updated',
        platform: 'linux',
        version: '3.1.0',
        agentList: [],
      }),
    })

    expect(response.status).toBe(200)

    const node = db.raw
      .prepare('SELECT hostname, version FROM nodes WHERE node_id = ?')
      .get('node-001') as { hostname: string; version: string }
    expect(node.hostname).toBe('dev-1-updated')
    expect(node.version).toBe('3.1.0')
  })
})
