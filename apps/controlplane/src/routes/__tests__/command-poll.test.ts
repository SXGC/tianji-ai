import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { createCommandPollRoute } from '../command-poll.js'
import { createNodeRegisterRoute } from '../node-register.js'

describe('GET /api/nodes/:nodeId/commands/poll', () => {
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

    const app = new Hono()
    app.route('/', createNodeRegisterRoute(db))
    app.route('/', createCommandPollRoute(db))

    const response = await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-001',
        enrollmentToken: 'valid-token',
        hostname: 'dev',
        platform: 'linux',
        version: '3.0.0',
        agentList: [],
      }),
    })

    accessToken = ((await response.json()) as { accessToken: string }).accessToken
    return app
  }

  it('should return 204 when no pending commands', async () => {
    const app = await setup()
    const response = await app.request('/api/nodes/node-001/commands/poll?timeout=100', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    expect(response.status).toBe(204)
  })

  it('should return pending command and mark as leased', async () => {
    const app = await setup()
    const now = Date.now()

    db.raw
      .prepare(
        `INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
         VALUES ('cmd-1', 'node-001', 'task.run', ?, 'pending', ?)`
      )
      .run(JSON.stringify({ taskId: 'task-1', agentId: 'default', goal: 'test goal' }), now)

    db.raw
      .prepare(
        `INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
         VALUES ('task-1', 'cmd-1', 'node-001', 'default', 'test goal', 'pending', ?, ?)`
      )
      .run(now, now)

    const response = await app.request('/api/nodes/node-001/commands/poll?timeout=100', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    expect(response.status).toBe(200)

    const data = (await response.json()) as { commandId: string; type: string }
    expect(data.commandId).toBe('cmd-1')
    expect(data.type).toBe('task.run')

    const command = db.raw
      .prepare('SELECT state FROM commands WHERE command_id = ?')
      .get('cmd-1') as { state: string }
    expect(command.state).toBe('leased')
  })

  it('should not return command when node execution_state is busy', async () => {
    const app = await setup()
    const now = Date.now()

    db.raw.prepare('UPDATE nodes SET execution_state = ? WHERE node_id = ?').run('busy', 'node-001')
    db.raw
      .prepare(
        `INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
         VALUES ('cmd-1', 'node-001', 'task.run', '{}', 'pending', ?)`
      )
      .run(now)
    db.raw
      .prepare(
        `INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
         VALUES ('task-1', 'cmd-1', 'node-001', 'default', 'test', 'pending', ?, ?)`
      )
      .run(now, now)

    const response = await app.request('/api/nodes/node-001/commands/poll?timeout=100', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    expect(response.status).toBe(204)
  })
})
