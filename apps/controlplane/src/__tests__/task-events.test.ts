/**
 * task-events 路由集成测试（旧版 lifecycle 状态更新已迁移到 bus subscriber）。
 *
 * 本文件验证路由在 DomainEventEnvelope 模式下的核心行为：
 * - 认证鉴权
 * - 合法 envelope → publish 到 bus
 * - 校验失败 → 500（Let it crash）
 */

import { createMemorySink, createObserverLogger } from '@tianji/observer'
import type { DomainEventEnvelope } from '@tianji/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../db/index.js'
import { createTaskEventsRoute } from '../routes/task-events.js'
import { hashToken } from '../services/auth.js'

/** 构造合法的 Task 聚合 DomainEventEnvelope（node 进程写入）。 */
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
    source: { processKind: 'node', processId: 'p1', nodeId: 'node-1' },
    payload: {} as never,
    ...overrides,
  } as DomainEventEnvelope
}

/**
 * 初始化内存数据库并插入 node 记录，返回可用于测试的 access token。
 */
function seedTestData(db: ControlPlaneDb): { token: string; nodeId: string } {
  const token = 'test-access-token'
  const tokenHash = hashToken(token)
  const now = Date.now()
  const nodeId = 'node-1'

  db.raw
    .prepare('INSERT INTO enrollment_tokens(token, created_at) VALUES(?, ?)')
    .run('enroll-1', now)
  db.raw
    .prepare(
      `INSERT INTO nodes(node_id, hostname, platform, version, access_token_hash, access_token_expires_at, enrollment_token, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(nodeId, 'host', 'linux', '1.0', tokenHash, now + 3_600_000, 'enroll-1', now, now)

  return { token, nodeId }
}

describe('task-events route', () => {
  let db: ControlPlaneDb
  let seed: ReturnType<typeof seedTestData>

  beforeEach(() => {
    db = createDatabase(':memory:')
    seed = seedTestData(db)
  })

  /** 构造经过认证的 POST 请求。 */
  function postEvents(
    taskId: string,
    body: string,
    overrides: { token?: string; bus?: { publish: ReturnType<typeof vi.fn> } } = {}
  ) {
    const bus = overrides.bus ?? { publish: vi.fn(), subscribe: vi.fn() }
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const app = createTaskEventsRoute({ db, logger, bus })
    return {
      response: app.request(`http://localhost/api/tasks/${taskId}/events`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${overrides.token ?? seed.token}`,
          'Content-Type': 'application/x-ndjson',
        },
        body,
      }),
      bus,
    }
  }

  it('returns 401 without authorization header', async () => {
    const bus = { publish: vi.fn(), subscribe: vi.fn() }
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const app = createTaskEventsRoute({ db, logger, bus })
    const res = await app.request('http://localhost/api/tasks/task-1/events', {
      method: 'POST',
      body: '{}',
    })
    expect(res.status).toBe(401)
    db.close()
  })

  it('returns 401 with invalid token', async () => {
    const { response } = postEvents('task-1', '{}', { token: 'bad-token' })
    const res = await response
    expect(res.status).toBe(401)
    db.close()
  })

  it('接收合法 DomainEventEnvelope，publish 到 bus 并返回 accepted 计数', async () => {
    const bus = { publish: vi.fn(), subscribe: vi.fn() }
    const envelope1 = makeTaskEnvelope({ sequence: 1 })
    const envelope2 = makeTaskEnvelope({ sequence: 2 })
    const body = `${JSON.stringify(envelope1)}\n${JSON.stringify(envelope2)}`

    const { response } = postEvents('task-1', body, { bus })
    const res = await response

    expect(res.status).toBe(200)
    const json = (await res.json()) as { accepted: number }
    expect(json.accepted).toBe(2)
    expect(bus.publish).toHaveBeenCalledTimes(2)
    db.close()
  })

  it('跳过 NDJSON 中的空行', async () => {
    const bus = { publish: vi.fn(), subscribe: vi.fn() }
    const envelope = makeTaskEnvelope({ sequence: 1 })
    const body = `${JSON.stringify(envelope)}\n\n\n`

    const { response } = postEvents('task-1', body, { bus })
    const res = await response
    const json = (await res.json()) as { accepted: number }
    expect(json.accepted).toBe(1)
    db.close()
  })

  it('校验失败（Node 聚合由 node 进程写入）→ 500，不 publish', async () => {
    const bus = { publish: vi.fn(), subscribe: vi.fn() }
    const invalidEnvelope = makeTaskEnvelope({
      aggregateType: 'Node',
      source: { processKind: 'node', processId: 'p1', nodeId: 'node-1' },
    })

    const { response } = postEvents('task-1', JSON.stringify(invalidEnvelope), { bus })
    const res = await response

    expect(res.status).toBe(500)
    expect(bus.publish).not.toHaveBeenCalled()
    db.close()
  })

  it('流式 NDJSON body 逐行处理', async () => {
    const bus = { publish: vi.fn(), subscribe: vi.fn() }
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const app = createTaskEventsRoute({ db, logger, bus })

    let pushChunk!: (chunk: string) => void
    let closeStream!: () => void

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        pushChunk = (chunk: string) => controller.enqueue(encoder.encode(chunk))
        closeStream = () => controller.close()
      },
    })

    const responsePromise = app.request('http://localhost/api/tasks/task-1/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${seed.token}`,
        'Content-Type': 'application/x-ndjson',
      },
      body,
      duplex: 'half',
    } as RequestInit)

    const envelope = makeTaskEnvelope({ sequence: 1 })
    pushChunk(`${JSON.stringify(envelope)}\n`)

    await new Promise((r) => setTimeout(r, 50))

    closeStream()
    const res = await responsePromise
    expect(res.status).toBe(200)

    const json = (await res.json()) as { accepted: number }
    expect(json.accepted).toBe(1)
    expect(bus.publish).toHaveBeenCalledTimes(1)
    db.close()
  })
})
