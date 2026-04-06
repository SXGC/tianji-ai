import { createMemorySink, createObserverLogger } from '@tianji/observer'
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { generateAccessToken, hashToken } from '../../services/auth.js'
import { createTaskEventsRoute } from '../task-events.js'

describe('POST /api/tasks/:taskId/events', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    const token = generateAccessToken()
    const tokenHash = hashToken(token)
    const now = Date.now()

    db.raw.prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)').run('et', now)
    db.raw
      .prepare(
        `INSERT INTO nodes (
          node_id, hostname, platform, version, access_token_hash, access_token_expires_at, enrollment_token, created_at, updated_at
        ) VALUES ('n1', 'h', 'linux', '1', ?, ?, 'et', ?, ?)`
      )
      .run(tokenHash, now + 999999, now, now)
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

    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const app = new Hono()
    app.route('/', createTaskEventsRoute(db, logger))

    return { app, token }
  }

  it('should accept NDJSON body and persist events', async () => {
    const { app, token } = setup()
    const body = `${[
      JSON.stringify({
        kind: 'lifecycle',
        taskId: 'task-1',
        type: 'task.started',
        sequence: 1,
        timestamp: Date.now(),
      }),
      JSON.stringify({
        kind: 'agent',
        taskId: 'task-1',
        sequence: 2,
        sessionId: 's1',
        runId: 'r1',
        event: { type: 'message.delta' },
      }),
    ].join('\n')}
`

    const response = await app.request('/api/tasks/task-1/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${token}`,
      },
      body,
    })

    expect(response.status).toBe(200)

    const events = db.raw
      .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY sequence')
      .all('task-1')
    expect(events).toHaveLength(2)
  })
})
