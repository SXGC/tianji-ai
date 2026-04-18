import { createMemorySink, createObserverLogger } from '@tianji/observer'
import type { PollCommandResponse } from '@tianji/shared'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { CommandWaiterRegistry } from '../../services/command-waiter-registry.js'
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

    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const registry = new CommandWaiterRegistry()
    const app = new Hono()
    app.route('/', createNodeRegisterRoute(db, logger))
    app.route('/', createCommandPollRoute(db, logger, registry))

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
    return { app, registry }
  }

  it('should return 204 when no pending commands', async () => {
    const { app } = await setup()
    const response = await app.request('/api/nodes/node-001/commands/poll?timeout=100', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    expect(response.status).toBe(204)
  })

  it('should return pending command and mark as leased', async () => {
    const { app } = await setup()
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

  it('should return a pending task.cancel command with structured payload', async () => {
    const { app } = await setup()
    const now = Date.now()

    db.raw
      .prepare(
        `INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
         VALUES ('cmd-cancel-1', 'node-001', 'task.cancel', ?, 'pending', ?)`
      )
      .run(JSON.stringify({ taskId: 'task-to-cancel', reason: 'user' }), now)

    const response = await app.request('/api/nodes/node-001/commands/poll?timeout=100', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    expect(response.status).toBe(200)

    const data = (await response.json()) as PollCommandResponse
    expect(data.commandId).toBe('cmd-cancel-1')
    expect(data.type).toBe('task.cancel')
    if (data.type === 'task.cancel') {
      expect(data.payload.taskId).toBe('task-to-cancel')
      expect(data.payload.reason).toBe('user')
    }

    const command = db.raw
      .prepare('SELECT state FROM commands WHERE command_id = ?')
      .get('cmd-cancel-1') as { state: string }
    expect(command.state).toBe('leased')
  })

  it('should not return command when node execution_state is busy', async () => {
    const { app } = await setup()
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

  it('should return command after waiter notify wakes a pending poll', async () => {
    const { app, registry } = await setup()
    const pollPromise = app.request('/api/nodes/node-001/commands/poll?timeout=500', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    await new Promise((resolve) => setTimeout(resolve, 20))

    const now = Date.now()
    db.raw
      .prepare(
        `INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
         VALUES ('cmd-notify-1', 'node-001', 'task.run', ?, 'pending', ?)`
      )
      .run(
        JSON.stringify({ taskId: 'task-notify-1', agentId: 'default', goal: 'notify goal' }),
        now
      )
    db.raw
      .prepare(
        `INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
         VALUES ('task-notify-1', 'cmd-notify-1', 'node-001', 'default', 'notify goal', 'pending', ?, ?)`
      )
      .run(now, now)
    registry.notify('node-001')

    const response = await pollPromise
    expect(response.status).toBe(200)

    const data = (await response.json()) as PollCommandResponse
    expect(data.commandId).toBe('cmd-notify-1')
    expect(data.type).toBe('task.run')
  })

  it('should lease the same command to only one poll when requests are concurrent', async () => {
    const { app, registry } = await setup()
    const headers = { Authorization: `Bearer ${accessToken}` }

    const pollPromiseA = app.request('/api/nodes/node-001/commands/poll?timeout=300', { headers })
    const pollPromiseB = app.request('/api/nodes/node-001/commands/poll?timeout=300', { headers })

    await new Promise((resolve) => setTimeout(resolve, 20))

    const now = Date.now()
    db.raw
      .prepare(
        `INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
         VALUES ('cmd-race-1', 'node-001', 'task.run', ?, 'pending', ?)`
      )
      .run(JSON.stringify({ taskId: 'task-race-1', agentId: 'default', goal: 'race goal' }), now)
    db.raw
      .prepare(
        `INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
         VALUES ('task-race-1', 'cmd-race-1', 'node-001', 'default', 'race goal', 'pending', ?, ?)`
      )
      .run(now, now)
    registry.notify('node-001')

    const [responseA, responseB] = await Promise.all([pollPromiseA, pollPromiseB])
    const statuses = [responseA.status, responseB.status].sort((a, b) => a - b)
    expect(statuses).toEqual([200, 204])

    const winner = responseA.status === 200 ? responseA : responseB
    const data = (await winner.json()) as PollCommandResponse
    expect(data.commandId).toBe('cmd-race-1')
    expect(data.type).toBe('task.run')

    const command = db.raw
      .prepare('SELECT state FROM commands WHERE command_id = ?')
      .get('cmd-race-1') as { state: string }
    expect(command.state).toBe('leased')
  })
})
