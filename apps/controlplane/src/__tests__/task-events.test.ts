import { beforeEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../db/index.js'
import { createTaskEventsRoute } from '../routes/task-events.js'
import { hashToken } from '../services/auth.js'

/**
 * 在内存数据库中插入完整的 node + command + task 数据链，
 * 返回可用于测试的 access token。
 */
function seedTestData(db: ControlPlaneDb): {
  token: string
  nodeId: string
  taskId: string
  commandId: string
} {
  const token = 'test-access-token'
  const tokenHash = hashToken(token)
  const now = Date.now()
  const nodeId = 'node-1'
  const commandId = 'cmd-1'
  const taskId = 'task-1'

  db.raw
    .prepare('INSERT INTO enrollment_tokens(token, created_at) VALUES(?, ?)')
    .run('enroll-1', now)
  db.raw
    .prepare(
      `INSERT INTO nodes(node_id, hostname, platform, version, access_token_hash, access_token_expires_at, enrollment_token, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(nodeId, 'host', 'linux', '1.0', tokenHash, now + 3_600_000, 'enroll-1', now, now)
  db.raw
    .prepare(
      `INSERT INTO commands(command_id, node_id, type, payload, state, created_at)
       VALUES(?, ?, ?, ?, ?, ?)`
    )
    .run(commandId, nodeId, 'run', '{}', 'pending', now)
  db.raw
    .prepare(
      `INSERT INTO tasks(task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(taskId, commandId, nodeId, 'agent-1', 'test goal', 'pending', now, now)

  return { token, nodeId, taskId, commandId }
}

describe('task-events route', () => {
  let db: ControlPlaneDb
  let seed: ReturnType<typeof seedTestData>

  beforeEach(() => {
    db = createDatabase(':memory:')
    seed = seedTestData(db)
  })

  /** 构造经过认证的 POST 请求。 */
  function postEvents(taskId: string, body: string, token?: string) {
    const app = createTaskEventsRoute(db)
    return app.request(`http://localhost/api/tasks/${taskId}/events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token ?? seed.token}`,
        'Content-Type': 'application/x-ndjson',
      },
      body,
    })
  }

  it('returns 401 without authorization header', async () => {
    const app = createTaskEventsRoute(db)
    const res = await app.request(`http://localhost/api/tasks/${seed.taskId}/events`, {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(401)
    db.close()
  })

  it('returns 401 with invalid token', async () => {
    const res = await postEvents(seed.taskId, '{}', 'bad-token')
    expect(res.status).toBe(401)
    db.close()
  })

  it('accepts valid NDJSON events and returns accepted count', async () => {
    const body = [
      JSON.stringify({ kind: 'agent', sequence: 1 }),
      JSON.stringify({ kind: 'agent', sequence: 2 }),
    ].join('\n')

    const res = await postEvents(seed.taskId, body)
    expect(res.status).toBe(200)

    const json = (await res.json()) as { accepted: number }
    expect(json.accepted).toBe(2)
    db.close()
  })

  it('skips blank lines in NDJSON body', async () => {
    const body = `${JSON.stringify({ kind: 'agent', sequence: 1 })}\n\n\n${JSON.stringify({ kind: 'agent', sequence: 2 })}\n`

    const res = await postEvents(seed.taskId, body)
    const json = (await res.json()) as { accepted: number }
    expect(json.accepted).toBe(2)
    db.close()
  })

  it('skips malformed JSON lines without failing', async () => {
    const body = `not-json\n${JSON.stringify({ kind: 'agent', sequence: 1 })}\n`

    const res = await postEvents(seed.taskId, body)
    expect(res.status).toBe(200)

    const json = (await res.json()) as { accepted: number }
    expect(json.accepted).toBe(2)
    db.close()
  })

  describe('lifecycle events update task status', () => {
    it('task.started sets status to running', async () => {
      const body = JSON.stringify({
        kind: 'lifecycle',
        sequence: 1,
        type: 'task.started',
        summary: 'starting',
      })

      await postEvents(seed.taskId, body)

      const row = db.raw
        .prepare('SELECT status, summary FROM tasks WHERE task_id = ?')
        .get(seed.taskId) as { status: string; summary: string }
      expect(row.status).toBe('running')
      expect(row.summary).toBe('starting')
      db.close()
    })

    it('task.waiting sets status to waiting', async () => {
      const body = JSON.stringify({
        kind: 'lifecycle',
        sequence: 1,
        type: 'task.waiting',
        summary: 'waiting for input',
      })

      await postEvents(seed.taskId, body)

      const row = db.raw
        .prepare('SELECT status, summary FROM tasks WHERE task_id = ?')
        .get(seed.taskId) as { status: string; summary: string }
      expect(row.status).toBe('waiting')
      expect(row.summary).toBe('waiting for input')
      db.close()
    })

    it('task.completed sets task and command status', async () => {
      const body = JSON.stringify({
        kind: 'lifecycle',
        sequence: 1,
        type: 'task.completed',
        summary: 'done',
      })

      await postEvents(seed.taskId, body)

      const task = db.raw
        .prepare('SELECT status, summary FROM tasks WHERE task_id = ?')
        .get(seed.taskId) as { status: string; summary: string }
      expect(task.status).toBe('completed')
      expect(task.summary).toBe('done')

      const cmd = db.raw
        .prepare('SELECT state FROM commands WHERE command_id = ?')
        .get(seed.commandId) as { state: string }
      expect(cmd.state).toBe('completed')
      db.close()
    })

    it('task.failed sets task failure_reason and command state', async () => {
      const body = JSON.stringify({
        kind: 'lifecycle',
        sequence: 1,
        type: 'task.failed',
        error: 'something broke',
      })

      await postEvents(seed.taskId, body)

      const task = db.raw
        .prepare('SELECT status, failure_reason FROM tasks WHERE task_id = ?')
        .get(seed.taskId) as { status: string; failure_reason: string }
      expect(task.status).toBe('failed')
      expect(task.failure_reason).toBe('something broke')

      const cmd = db.raw
        .prepare('SELECT state FROM commands WHERE command_id = ?')
        .get(seed.commandId) as { state: string }
      expect(cmd.state).toBe('failed')
      db.close()
    })

    it('task.failed uses default error when error field is missing', async () => {
      const body = JSON.stringify({
        kind: 'lifecycle',
        sequence: 1,
        type: 'task.failed',
      })

      await postEvents(seed.taskId, body)

      const task = db.raw
        .prepare('SELECT failure_reason FROM tasks WHERE task_id = ?')
        .get(seed.taskId) as { failure_reason: string }
      expect(task.failure_reason).toBe('agent_error')
      db.close()
    })

    it('task.cancelled sets cancelled status and updates command', async () => {
      const body = JSON.stringify({
        kind: 'lifecycle',
        sequence: 1,
        type: 'task.cancelled',
      })

      await postEvents(seed.taskId, body)

      const task = db.raw
        .prepare('SELECT status, failure_reason FROM tasks WHERE task_id = ?')
        .get(seed.taskId) as { status: string; failure_reason: string }
      expect(task.status).toBe('cancelled')
      expect(task.failure_reason).toBe('cancelled_by_user')

      const cmd = db.raw
        .prepare('SELECT state FROM commands WHERE command_id = ?')
        .get(seed.commandId) as { state: string }
      expect(cmd.state).toBe('failed')
      db.close()
    })

    it('task.session.attached inserts into task_sessions', async () => {
      // 需要先在 sessions 表中插入 session 记录（外键约束）
      const now = Date.now()
      db.raw
        .prepare(
          `INSERT INTO sessions(session_id, node_id, agent_id, created_by, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?)`
        )
        .run('sess-1', seed.nodeId, 'agent-1', 'task', now, now)

      const body = JSON.stringify({
        kind: 'lifecycle',
        sequence: 1,
        type: 'task.session.attached',
        sessionId: 'sess-1',
      })

      await postEvents(seed.taskId, body)

      const row = db.raw
        .prepare('SELECT task_id, session_id, attached_by FROM task_sessions WHERE task_id = ?')
        .get(seed.taskId) as { task_id: string; session_id: string; attached_by: string }
      expect(row.session_id).toBe('sess-1')
      expect(row.attached_by).toBe('agent')
      db.close()
    })

    it('task.session.attached without sessionId does not insert', async () => {
      const body = JSON.stringify({
        kind: 'lifecycle',
        sequence: 1,
        type: 'task.session.attached',
      })

      await postEvents(seed.taskId, body)

      const row = db.raw
        .prepare('SELECT COUNT(*) as cnt FROM task_sessions WHERE task_id = ?')
        .get(seed.taskId) as { cnt: number }
      expect(row.cnt).toBe(0)
      db.close()
    })

    it('task.started with no summary sets null summary', async () => {
      const body = JSON.stringify({
        kind: 'lifecycle',
        sequence: 1,
        type: 'task.started',
      })

      await postEvents(seed.taskId, body)

      const row = db.raw
        .prepare('SELECT summary FROM tasks WHERE task_id = ?')
        .get(seed.taskId) as { summary: string | null }
      expect(row.summary).toBeNull()
      db.close()
    })

    it('lifecycle event with unknown type does not crash', async () => {
      const body = JSON.stringify({
        kind: 'lifecycle',
        sequence: 1,
        type: 'task.unknown_event',
      })

      const res = await postEvents(seed.taskId, body)
      expect(res.status).toBe(200)
      db.close()
    })
  })

  it('non-lifecycle kind does not trigger updateTaskFromLifecycle', async () => {
    const body = JSON.stringify({
      kind: 'agent',
      sequence: 1,
      type: 'task.started',
    })

    await postEvents(seed.taskId, body)

    const task = db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get(seed.taskId) as {
      status: string
    }
    expect(task.status).toBe('pending')
    db.close()
  })

  it('lifecycle event with undefined type does not trigger update', async () => {
    const body = JSON.stringify({
      kind: 'lifecycle',
      sequence: 1,
    })

    await postEvents(seed.taskId, body)

    const task = db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get(seed.taskId) as {
      status: string
    }
    expect(task.status).toBe('pending')
    db.close()
  })
})
