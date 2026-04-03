import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { ObservationMonitor } from '../observation-monitor.js'

describe('ObservationMonitor', () => {
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
        ) VALUES ('n1', 'h', 'linux', '1', 'online', 'h', 999999999999999, 't', ?, ?, ?)`
      )
      .run(now, now, now)
    db.raw
      .prepare(
        `INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
         VALUES ('cmd-1', 'n1', 'task.run', '{}', 'leased', ?)`
      )
      .run(now)

    return now
  }

  it('should mark running tasks as observation_lost when node goes offline', () => {
    const now = setup()

    db.raw
      .prepare(
        `INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
         VALUES ('task-1', 'cmd-1', 'n1', 'a', 'g', 'running', ?, ?)`
      )
      .run(now, now)

    db.raw
      .prepare('UPDATE nodes SET last_heartbeat_at = ?, status = ? WHERE node_id = ?')
      .run(now - 120_000, 'offline', 'n1')

    const monitor = new ObservationMonitor(db)
    monitor.checkOfflineNodes()

    const task = db.raw
      .prepare('SELECT status, failure_reason FROM tasks WHERE task_id = ?')
      .get('task-1') as { status: string; failure_reason: string }
    expect(task.status).toBe('observation_lost')
    expect(task.failure_reason).toBe('observation_lost')
  })

  it('should not affect tasks in terminal states', () => {
    const now = setup()

    db.raw
      .prepare(
        `INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
         VALUES ('task-1', 'cmd-1', 'n1', 'a', 'g', 'completed', ?, ?)`
      )
      .run(now, now)

    db.raw
      .prepare('UPDATE nodes SET last_heartbeat_at = ?, status = ? WHERE node_id = ?')
      .run(now - 120_000, 'offline', 'n1')

    const monitor = new ObservationMonitor(db)
    monitor.checkOfflineNodes()

    const task = db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get('task-1') as {
      status: string
    }
    expect(task.status).toBe('completed')
  })
})
