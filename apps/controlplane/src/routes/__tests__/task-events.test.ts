/**
 * POST /api/tasks/:taskId/events 路由测试。
 *
 * 验证路由正确消费 DomainEventEnvelope NDJSON：
 * - 合法 envelope → ingest 被调用 → bus.publish 触发
 * - 校验失败的 envelope → throw → bus.publish 不被调用
 * - 认证失败 → 401
 */

import { createMemorySink, createObserverLogger } from '@tianji/observer'
import type { DomainEventEnvelope } from '@tianji/shared'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { generateAccessToken, hashToken } from '../../services/auth.js'
import { createTaskEventsRoute } from '../task-events.js'

/** 构造合法的 DomainEventEnvelope（Task 聚合，node 进程写入）。 */
function makeTaskEnvelope(overrides: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope {
  return {
    eventId: crypto.randomUUID(),
    type: 'TaskStarted',
    occurredAt: new Date().toISOString(),
    correlationId: crypto.randomUUID(),
    causationId: null,
    sequence: 1,
    aggregateType: 'Task',
    aggregateId: 'task-1',
    source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
    payload: {} as never,
    ...overrides,
  } as DomainEventEnvelope
}

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

    const bus = { publish: vi.fn(), subscribe: vi.fn() }
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const app = new Hono()
    app.route('/', createTaskEventsRoute({ db, logger, bus }))

    return { app, token, bus }
  }

  it('returns 401 without authorization header', async () => {
    const { app } = setup()
    const res = await app.request('/api/tasks/task-1/events', {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(401)
  })

  it('接收合法 DomainEventEnvelope NDJSON，publish 到 bus', async () => {
    const { app, token, bus } = setup()

    const envelope1 = makeTaskEnvelope({ sequence: 1 })
    const envelope2 = makeTaskEnvelope({ sequence: 2 })
    const body = `${JSON.stringify(envelope1)}\n${JSON.stringify(envelope2)}\n`

    const res = await app.request('/api/tasks/task-1/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${token}`,
      },
      body,
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { accepted: number }
    expect(json.accepted).toBe(2)
    expect(bus.publish).toHaveBeenCalledTimes(2)
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: envelope1.eventId })
    )
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: envelope2.eventId })
    )
  })

  it('校验失败（writer-rules 不通过）→ throw → bus.publish 不被调用', async () => {
    const { app, token, bus } = setup()

    // Node 聚合只允许 cp 写入，node 进程写入会触发 validateWriter throw。
    const invalidEnvelope = makeTaskEnvelope({
      aggregateType: 'Node',
      source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
    })
    const body = JSON.stringify(invalidEnvelope)

    const res = await app.request('/api/tasks/task-1/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${token}`,
      },
      body,
    })

    // throw → Hono 回 500（Let it crash）
    expect(res.status).toBe(500)
    expect(bus.publish).not.toHaveBeenCalled()
  })

  it('空 body 返回 accepted: 0，不调用 publish', async () => {
    const { app, token, bus } = setup()

    const res = await app.request('/api/tasks/task-1/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${token}`,
      },
      // body 为空（undefined），Hono 中 body 为 null
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { accepted: number }
    expect(json.accepted).toBe(0)
    expect(bus.publish).not.toHaveBeenCalled()
  })

  it('跳过 NDJSON 中的空行', async () => {
    const { app, token, bus } = setup()

    const envelope = makeTaskEnvelope({ sequence: 1 })
    const body = `\n\n${JSON.stringify(envelope)}\n\n`

    const res = await app.request('/api/tasks/task-1/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${token}`,
      },
      body,
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { accepted: number }
    expect(json.accepted).toBe(1)
    expect(bus.publish).toHaveBeenCalledTimes(1)
  })
})
