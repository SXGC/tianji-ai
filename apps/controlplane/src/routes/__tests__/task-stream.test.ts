import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { EventStore } from '../../services/event-store.js'
import { createTaskStreamRoute } from '../task-stream.js'

describe('GET /api/ui/tasks/:taskId/stream (SSE)', () => {
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
    store.insertEvent('task-1', 1, 'lifecycle', JSON.stringify({ type: 'task.started' }))
    store.insertEvent(
      'task-1',
      2,
      'lifecycle',
      JSON.stringify({
        type: 'task.session.attached',
        sessionId: 'session-1',
      })
    )
    store.insertEvent(
      'task-1',
      3,
      'agent',
      JSON.stringify({
        kind: 'agent_event',
        event: {
          type: 'message.delta',
        },
      })
    )
    db.raw
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?')
      .run('completed', now + 1, 'task-1')
    store.insertEvent('task-1', 4, 'lifecycle', JSON.stringify({ type: 'task.completed' }))

    const app = new Hono()
    app.route('/', createTaskStreamRoute(db))
    return app
  }

  it('should stream existing events as SSE', async () => {
    const app = setup()
    const response = await app.request('/api/ui/tasks/task-1/stream', {
      headers: { Accept: 'text/event-stream' },
    })

    expect(response.status).toBe(200)

    const text = await response.text()
    expect(text).toContain('id: task-1:1')
    expect(text).toContain('id: task-1:2')
  })

  it('should expose nested agent event types in SSE event names', async () => {
    const app = setup()
    const response = await app.request('/api/ui/tasks/task-1/stream', {
      headers: { Accept: 'text/event-stream' },
    })

    const text = await response.text()
    expect(text).toContain('event: agent.message.delta')
  })

  it('streams lifecycle session attach events', async () => {
    const app = setup()
    const response = await app.request('/api/ui/tasks/task-1/stream', {
      headers: { Accept: 'text/event-stream' },
    })

    const text = await response.text()
    expect(text).toContain('event: task.lifecycle')
    expect(text).toContain('task.session.attached')
    expect(text).toContain('session-1')
  })

  it('should resume from Last-Event-ID', async () => {
    const app = setup()
    const response = await app.request('/api/ui/tasks/task-1/stream', {
      headers: {
        Accept: 'text/event-stream',
        'Last-Event-ID': 'task-1:1',
      },
    })

    const text = await response.text()
    expect(text).not.toContain('id: task-1:1')
    expect(text).toContain('id: task-1:2')
    expect(text).toContain('id: task-1:3')
    expect(text).toContain('id: task-1:4')
  })

  it('streams events inserted after the SSE connection starts', async () => {
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
    const app = new Hono()
    app.route('/', createTaskStreamRoute(db))

    const responsePromise = app.request('/api/ui/tasks/task-1/stream', {
      headers: { Accept: 'text/event-stream' },
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    store.insertEvent('task-1', 1, 'lifecycle', JSON.stringify({ type: 'task.started' }))
    store.insertEvent(
      'task-1',
      2,
      'agent',
      JSON.stringify({
        kind: 'agent_event',
        event: {
          type: 'message.delta',
          payload: {
            content: 'Hi',
          },
        },
      })
    )
    db.raw
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?')
      .run('completed', now + 1, 'task-1')
    store.insertEvent('task-1', 3, 'lifecycle', JSON.stringify({ type: 'task.completed' }))

    const response = await responsePromise
    const text = await response.text()

    expect(text).toContain('id: task-1:2')
    expect(text).toContain('Hi')
    expect(text).toContain('event: done')
  })
})
