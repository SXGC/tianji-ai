import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { createCopilotRoute } from '../copilot.js'

describe('POST /api/copilot', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    const app = new Hono()
    app.route('/', createCopilotRoute(db))
    return { app }
  }

  function insertNode(nodeId: string, status: 'online' | 'offline') {
    db.raw
      .prepare(
        `INSERT INTO enrollment_tokens (token, created_at) VALUES ('test-token', ${Date.now()})
         ON CONFLICT(token) DO NOTHING`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO nodes
           (node_id, hostname, platform, version, status, access_token_hash, access_token_expires_at, enrollment_token, created_at, updated_at)
         VALUES (?, 'host', 'linux', '1.0.0', ?, 'hash', ${Date.now() + 3600000}, 'test-token', ${Date.now()}, ${Date.now()})`
      )
      .run(nodeId, status)
  }

  it('x-node-id 缺失时返回 400', async () => {
    const { app } = setup()
    const response = await app.request('/api/copilot', {
      method: 'POST',
      headers: { 'x-agent-id': 'agent-1' },
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('x-node-id')
  })

  it('x-agent-id 缺失时返回 400', async () => {
    const { app } = setup()
    const response = await app.request('/api/copilot', {
      method: 'POST',
      headers: { 'x-node-id': 'node-1' },
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('x-agent-id')
  })

  it('x-node-id 为空字符串时返回 400', async () => {
    const { app } = setup()
    const response = await app.request('/api/copilot', {
      method: 'POST',
      headers: { 'x-node-id': '', 'x-agent-id': 'agent-1' },
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('x-node-id')
  })

  it('节点不存在时返回 404', async () => {
    const { app } = setup()
    const response = await app.request('/api/copilot', {
      method: 'POST',
      headers: { 'x-node-id': 'nonexistent-node', 'x-agent-id': 'agent-1' },
    })

    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('not found')
  })

  it('节点处于 offline 状态时返回 409', async () => {
    const { app } = setup()
    insertNode('offline-node', 'offline')

    const response = await app.request('/api/copilot', {
      method: 'POST',
      headers: { 'x-node-id': 'offline-node', 'x-agent-id': 'agent-1' },
    })

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('offline')
  })

  it('在线节点聊天请求不会因 this.run 丢失而报错', async () => {
    const { app } = setup()
    insertNode('node-1', 'online')

    const response = await app.request('/api/copilot', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-node-id': 'node-1',
        'x-agent-id': 'agent-1',
      },
      body: JSON.stringify({
        method: 'agent/run',
        params: {
          agentId: 'default',
        },
        body: {
          threadId: 'thread-1',
          runId: 'run-1',
          messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
          tools: [],
          context: [],
          forwardedProps: {},
          state: {},
        },
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
  })
})
