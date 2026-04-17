# Control Plane Debug UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Control Plane 构建一个仅开发环境可用的浮动调试面板，集中展示领域事件流（实时 + 历史）和节点运维状态。

**Architecture:** 后端新增 `/api/debug/events` 与 `/api/debug/nodes` 两条 REST 接口，通过 `TIANJI_DEBUG=true` 条件挂载；前端新增 Zustand store、REST service、Panel + Toolbar 组件、三个自定义 Hook（窗口拖拽 / 实时轮询 / 历史滚动），通过 `VITE_ENABLE_DEBUG === 'true'` 严格判断渲染。全局游标统一使用 `event_log.rowid`，硬编码排除 `MessageDelta` / `TaskMessageDelta`。

**Tech Stack:**
- 后端：Hono、better-sqlite3、zod、Vitest
- 前端：React 19、TanStack Router、Zustand、@ag-ui/client、Vite、Vitest、React Testing Library

**Spec：** `docs/superpowers/specs/2026-04-17-control-plane-debug-ui-design.md`

**通用约束：**
- 每个文件 ≤ 800 行（CLAUDE.md 硬规定）
- 禁止 `any`、禁止动态 import（`await import(...)`、`import("pkg").Type` 都不行）
- 测试从对应包的根目录执行（`cd apps/controlplane && pnpm vitest run ...`）
- 每个 Task 结束前运行 `pnpm check` 并修复所有错误 / 警告
- 每个 Task 结束做一次独立 commit。**执行 `git commit` 前必须先加载 `git commit` skill**（CLAUDE.md 硬规定，不得绕过）；
  提交消息不得包含 `Co-Authored-By` 或任何 AI 标记。各 Task 中给出的 `git commit -m` 只是**消息正文模板**，实际执行时走 skill 的确认流程。

---

## Task 1: 后端 `/api/debug/events` 路由

**Files:**
- Create: `apps/controlplane/src/routes/debug-events.ts`
- Create: `apps/controlplane/src/routes/__tests__/debug-events.test.ts`

**范围：** 实现单个 Hono 子路由 `createDebugEventsRoute(db)`。参数校验用 zod；游标用 `rowid`；硬编码过滤 `MessageDelta` / `TaskMessageDelta`；返回体包含 `events / maxCursor / minCursor / hasMore`；排序按 `rowid` 降序。

- [ ] **Step 1：新建测试文件骨架并写 realtime bootstrap 失败测试**

创建 `apps/controlplane/src/routes/__tests__/debug-events.test.ts`：

```ts
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { SCHEMA_SQL } from '../../db/schema.js'
import { createDebugEventsRoute } from '../debug-events.js'

interface RawEvent {
  eventId: string
  type: string
  occurredAt: string
  correlationId: string
  causationId: string | null
  sequence: number
  aggregateType: 'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node'
  aggregateId: string
  source: { processKind: 'daemon' | 'node' | 'cp'; processId: string }
  payload: Record<string, unknown>
}

function setupDb() {
  const raw = new Database(':memory:')
  raw.exec(SCHEMA_SQL)
  const db = { raw } as unknown as { raw: Database.Database }
  return { raw, db }
}

function insertEvent(raw: Database.Database, ev: RawEvent): void {
  raw
    .prepare(
      `INSERT INTO event_log
       (event_id, type, occurred_at, correlation_id, causation_id, sequence,
        aggregate_type, aggregate_id, source_json, payload_json)
       VALUES (@e, @t, @o, @c, @ca, @s, @at, @ai, @src, @pl)`
    )
    .run({
      e: ev.eventId,
      t: ev.type,
      o: ev.occurredAt,
      c: ev.correlationId,
      ca: ev.causationId,
      s: ev.sequence,
      at: ev.aggregateType,
      ai: ev.aggregateId,
      src: JSON.stringify(ev.source),
      pl: JSON.stringify(ev.payload),
    })
}

function makeEv(overrides: Partial<RawEvent> & Pick<RawEvent, 'eventId' | 'sequence'>): RawEvent {
  return {
    type: 'RunStarted',
    occurredAt: new Date().toISOString(),
    correlationId: 'c-1',
    causationId: null,
    aggregateType: 'Run',
    aggregateId: 'run-1',
    source: { processKind: 'daemon', processId: 'p-1' },
    payload: {},
    ...overrides,
  }
}

describe('GET /api/debug/events realtime', () => {
  test('bootstrap 请求返回最近 100 条并按 rowid 降序', async () => {
    const { raw, db } = setupDb()
    for (let i = 1; i <= 150; i++) {
      insertEvent(raw, makeEv({ eventId: `e-${i}`, sequence: i }))
    }
    const app = createDebugEventsRoute(db as never)
    const res = await app.request('/api/debug/events?mode=realtime')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      events: Array<{ eventId: string; cursor: number }>
      maxCursor: number
      minCursor: number
      hasMore: boolean
    }
    expect(body.events).toHaveLength(100)
    expect(body.events[0]!.cursor).toBe(150)
    expect(body.events.at(-1)!.cursor).toBe(51)
    expect(body.maxCursor).toBe(150)
    expect(body.minCursor).toBe(51)
  })
})
```

- [ ] **Step 2：运行测试验证失败**

```bash
cd apps/controlplane && pnpm vitest run src/routes/__tests__/debug-events.test.ts
```

期望：模块不存在或函数未定义导致失败。

- [ ] **Step 3：实现最小路由**

创建 `apps/controlplane/src/routes/debug-events.ts`：

```ts
import { Hono } from 'hono'
import { z } from 'zod'

import type { ControlPlaneDb } from '../db/index.js'

const EXCLUDED_TYPES = ['MessageDelta', 'TaskMessageDelta'] as const

const querySchema = z.object({
  mode: z.enum(['realtime', 'history']),
  since_cursor: z.coerce.number().int().positive().optional(),
  before_cursor: z.coerce.number().int().positive().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  aggregate_type: z.enum(['Session', 'GraphRun', 'Run', 'Task', 'Node']).optional(),
  aggregate_id: z.string().optional(),
  // 上限在 handler 中用 Math.min 夹到 500（而非 .max(500) 拒绝），保持对前端的宽松语义。
  limit: z.coerce.number().int().positive().optional(),
})

const MAX_LIMIT = 500
const BOOTSTRAP_DEFAULT_LIMIT = 100
const HISTORY_DEFAULT_LIMIT = 200

interface RawRow {
  rowid: number
  event_id: string
  type: string
  occurred_at: string
  correlation_id: string
  causation_id: string | null
  sequence: number
  aggregate_type: string
  aggregate_id: string
  source_json: string
  payload_json: string
}

function rowToEnvelope(row: RawRow): Record<string, unknown> {
  return {
    eventId: row.event_id,
    type: row.type,
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    sequence: row.sequence,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    source: JSON.parse(row.source_json) as unknown,
    payload: JSON.parse(row.payload_json) as unknown,
    cursor: row.rowid,
  }
}

/**
 * Debug 专用：查询 event_log，支持实时（rowid > since_cursor）与历史（rowid < before_cursor +
 * occurred_at 范围）两种模式。永远按 rowid 降序返回；硬编码排除 MessageDelta / TaskMessageDelta。
 */
export function createDebugEventsRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()

  app.get('/api/debug/events', (c) => {
    const parsed = querySchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams.entries())
    )
    if (!parsed.success) {
      return c.json({ error: 'invalid query params' }, 400)
    }
    const q = parsed.data

    const where: string[] = ['type NOT IN (?, ?)']
    const params: Array<string | number> = [...EXCLUDED_TYPES]

    // bootstrap：realtime 且未传 since_cursor 时，默认 100 条；否则默认 200 条。
    // 用户显式传入的 limit 只做上限夹（≤ MAX_LIMIT=500），不覆盖用户意图。
    const isBootstrap = q.mode === 'realtime' && q.since_cursor === undefined
    const defaultLimit = isBootstrap ? BOOTSTRAP_DEFAULT_LIMIT : HISTORY_DEFAULT_LIMIT
    const effectiveLimit = Math.min(q.limit ?? defaultLimit, MAX_LIMIT)

    if (q.mode === 'realtime') {
      if (q.since_cursor !== undefined) {
        where.push('rowid > ?')
        params.push(q.since_cursor)
      }
    } else {
      if (q.before_cursor !== undefined) {
        where.push('rowid < ?')
        params.push(q.before_cursor)
      }
      if (q.start_time !== undefined) {
        where.push('occurred_at >= ?')
        params.push(q.start_time)
      }
      if (q.end_time !== undefined) {
        where.push('occurred_at <= ?')
        params.push(q.end_time)
      }
    }

    if (q.aggregate_type !== undefined) {
      where.push('aggregate_type = ?')
      params.push(q.aggregate_type)
    }
    if (q.aggregate_id !== undefined) {
      where.push('aggregate_id = ?')
      params.push(q.aggregate_id)
    }

    const sql = `SELECT rowid, * FROM event_log WHERE ${where.join(' AND ')}
                 ORDER BY rowid DESC LIMIT ?`
    params.push(effectiveLimit)
    const rows = db.raw.prepare(sql).all(...params) as RawRow[]
    const events = rows.map(rowToEnvelope)

    const hasMore = q.mode === 'history' && rows.length === effectiveLimit
    const maxCursor = rows[0]?.rowid ?? 0
    const minCursor = rows.at(-1)?.rowid ?? 0

    return c.json({ events, maxCursor, minCursor, hasMore })
  })

  return app
}
```

- [ ] **Step 4：再跑测试，验证通过**

```bash
cd apps/controlplane && pnpm vitest run src/routes/__tests__/debug-events.test.ts
```

期望：PASS。

- [ ] **Step 5：补齐剩余业务行为测试（追加到同一测试文件）**

```ts
describe('GET /api/debug/events realtime 增量', () => {
  test('since_cursor=N 只返回 rowid > N 的事件', async () => {
    const { raw, db } = setupDb()
    for (let i = 1; i <= 5; i++) {
      insertEvent(raw, makeEv({ eventId: `e-${i}`, sequence: i }))
    }
    const app = createDebugEventsRoute(db as never)
    const res = await app.request('/api/debug/events?mode=realtime&since_cursor=3')
    const body = (await res.json()) as { events: Array<{ cursor: number }> }
    expect(body.events.map((e) => e.cursor)).toEqual([5, 4])
  })

  test('跨聚合体的事件不会被游标跳过', async () => {
    const { raw, db } = setupDb()
    insertEvent(raw, makeEv({ eventId: 'a1', sequence: 1, aggregateId: 'A' }))
    insertEvent(raw, makeEv({ eventId: 'b1', sequence: 1, aggregateId: 'B' }))
    const app = createDebugEventsRoute(db as never)
    // 不传 since_cursor 即 bootstrap，应该返回两个不同聚合体的事件（event_log.sequence 是
    // 按 aggregate 维度递增的，跨 aggregate 会重复，全局排序必须依赖 rowid）。
    const res = await app.request('/api/debug/events?mode=realtime')
    const body = (await res.json()) as { events: Array<{ eventId: string }> }
    expect(body.events.map((e) => e.eventId).sort()).toEqual(['a1', 'b1'])
  })
})

describe('GET /api/debug/events 硬编码过滤', () => {
  test('MessageDelta 与 TaskMessageDelta 不会返回', async () => {
    const { raw, db } = setupDb()
    insertEvent(raw, makeEv({ eventId: 'd1', sequence: 1, type: 'MessageDelta' }))
    insertEvent(raw, makeEv({ eventId: 't1', sequence: 2, type: 'TaskMessageDelta' }))
    insertEvent(raw, makeEv({ eventId: 'r1', sequence: 3, type: 'RunStarted' }))
    const app = createDebugEventsRoute(db as never)
    const res = await app.request('/api/debug/events?mode=realtime')
    const body = (await res.json()) as { events: Array<{ type: string }> }
    expect(body.events.map((e) => e.type)).toEqual(['RunStarted'])
  })
})

describe('GET /api/debug/events history', () => {
  test('按时间范围过滤并支持 before_cursor 分页', async () => {
    const { raw, db } = setupDb()
    // i=1..10 对应 occurredAt = 1_001_000ms .. 1_010_000ms
    // rowid 从 1 起按 insert 顺序递增，正好 rowid === i。
    for (let i = 1; i <= 10; i++) {
      insertEvent(
        raw,
        makeEv({
          eventId: `e-${i}`,
          sequence: i,
          occurredAt: new Date(1_000_000 + i * 1000).toISOString(),
        })
      )
    }
    const app = createDebugEventsRoute(db as never)
    // start_time=1_002_000ms(i=2), end_time=1_009_000ms(i=9) → 命中 i=2..9（8 条）
    // limit=5 降序第一页 → rowid=9,8,7,6,5，hasMore=true，minCursor=5
    const firstRes = await app.request(
      '/api/debug/events?mode=history&start_time=1970-01-01T00:16:42.000Z&end_time=1970-01-01T00:16:49.000Z&limit=5'
    )
    const first = (await firstRes.json()) as {
      events: Array<{ cursor: number }>
      hasMore: boolean
      minCursor: number
    }
    expect(first.events.map((e) => e.cursor)).toEqual([9, 8, 7, 6, 5])
    expect(first.hasMore).toBe(true)
    expect(first.minCursor).toBe(5)
    // 第二页 before_cursor=5 → rowid<5 且在时间范围 → 命中 i=2,3,4 → [4,3,2]，hasMore=false
    const nextRes = await app.request(
      `/api/debug/events?mode=history&start_time=1970-01-01T00:16:42.000Z&end_time=1970-01-01T00:16:49.000Z&limit=5&before_cursor=${first.minCursor}`
    )
    const next = (await nextRes.json()) as { events: Array<{ cursor: number }>; hasMore: boolean }
    expect(next.events.map((e) => e.cursor)).toEqual([4, 3, 2])
    expect(next.hasMore).toBe(false)
  })
})

describe('GET /api/debug/events 参数校验', () => {
  test('缺失 mode 返回 400', async () => {
    const { db } = setupDb()
    const app = createDebugEventsRoute(db as never)
    const res = await app.request('/api/debug/events')
    expect(res.status).toBe(400)
  })

  test('since_cursor=0 返回 400（游标必须为正整数）', async () => {
    const { db } = setupDb()
    const app = createDebugEventsRoute(db as never)
    const res = await app.request('/api/debug/events?mode=realtime&since_cursor=0')
    expect(res.status).toBe(400)
  })

  test('limit 超过 500 会被截断到 500（非 400 拒绝）', async () => {
    const { raw, db } = setupDb()
    for (let i = 1; i <= 600; i++) {
      insertEvent(raw, makeEv({ eventId: `e-${i}`, sequence: i }))
    }
    const app = createDebugEventsRoute(db as never)
    // 这里不传 since_cursor，走 bootstrap 路径，defaultLimit=100；由于用户显式传 limit=1000，
    // handler 夹到 MAX_LIMIT=500。
    const res = await app.request('/api/debug/events?mode=realtime&limit=1000')
    const body = (await res.json()) as { events: unknown[] }
    expect(body.events.length).toBe(500)
  })

  test('用户显式 limit 小于默认值时不被覆盖', async () => {
    const { raw, db } = setupDb()
    for (let i = 1; i <= 50; i++) {
      insertEvent(raw, makeEv({ eventId: `e-${i}`, sequence: i }))
    }
    const app = createDebugEventsRoute(db as never)
    // bootstrap 默认 100，但用户要求 30 → 实际返回 30。
    const res = await app.request('/api/debug/events?mode=realtime&limit=30')
    const body = (await res.json()) as { events: unknown[] }
    expect(body.events.length).toBe(30)
  })
})
```

- [ ] **Step 6：跑全部测试并通过**

```bash
cd apps/controlplane && pnpm vitest run src/routes/__tests__/debug-events.test.ts
```

- [ ] **Step 7：运行 `pnpm check` 并修复所有问题**

```bash
pnpm check
```

- [ ] **Step 8：提交**

```bash
git add apps/controlplane/src/routes/debug-events.ts apps/controlplane/src/routes/__tests__/debug-events.test.ts
git commit -m "feat(controlplane): 新增 /api/debug/events 事件查询接口

基于 event_log.rowid 作为全局游标，支持实时（since_cursor）与历史（before_cursor +
时间范围）两种模式；硬编码排除 MessageDelta / TaskMessageDelta；限制单页最多 500 条。"
```

---

## Task 2: 后端 `/api/debug/nodes` 路由

**Files:**
- Create: `apps/controlplane/src/routes/debug-nodes.ts`
- Create: `apps/controlplane/src/routes/__tests__/debug-nodes.test.ts`

**范围：** 和 `ui-nodes.ts` 的逻辑基础一致，但加入 `registeredAt`（复用 `created_at`）并显式返回 `lastHeartbeatAt` 的 ISO 字符串。复用 `HEARTBEAT_TIMEOUT_MS`。

- [ ] **Step 1：写失败测试**

创建 `apps/controlplane/src/routes/__tests__/debug-nodes.test.ts`：

```ts
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { SCHEMA_SQL } from '../../db/schema.js'
import { createDebugNodesRoute } from '../debug-nodes.js'

function setupDb() {
  const raw = new Database(':memory:')
  raw.exec(SCHEMA_SQL)
  raw
    .prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)')
    .run('tok-1', 0)
  return { raw, db: { raw } as unknown as { raw: Database.Database } }
}

function insertNode(
  raw: Database.Database,
  nodeId: string,
  lastHeartbeatAt: number | null
): void {
  raw
    .prepare(
      `INSERT INTO nodes
       (node_id, hostname, platform, version, status, execution_state,
        access_token_hash, access_token_expires_at, enrollment_token, pid,
        last_heartbeat_at, created_at, updated_at)
       VALUES (@nid, 'h', 'linux', 'v1', 'offline', 'idle', 'x', 9999999999999, 'tok-1',
               NULL, @hb, 1000, 1000)`
    )
    .run({ nid: nodeId, hb: lastHeartbeatAt })
}

describe('GET /api/debug/nodes', () => {
  test('返回节点列表含 registeredAt / lastHeartbeatAt / status / agents', async () => {
    const { raw, db } = setupDb()
    insertNode(raw, 'n-online', Date.now())
    insertNode(raw, 'n-offline', null)
    raw
      .prepare(
        `INSERT INTO agents (node_id, agent_id, type, name, version, updated_at)
         VALUES ('n-online', 'a-1', 'native', 'Agent A', 'v1', 1000)`
      )
      .run()
    const app = createDebugNodesRoute(db as never)
    const res = await app.request('/api/debug/nodes')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      nodes: Array<{
        nodeId: string
        status: string
        registeredAt: string
        lastHeartbeatAt: string | null
        executionState: string
        agents: Array<{ agentId: string }>
      }>
    }
    const byId = Object.fromEntries(body.nodes.map((n) => [n.nodeId, n]))
    expect(byId['n-online']!.status).toBe('online')
    expect(byId['n-offline']!.status).toBe('offline')
    expect(byId['n-online']!.registeredAt).toBe(new Date(1000).toISOString())
    expect(byId['n-offline']!.lastHeartbeatAt).toBeNull()
    expect(byId['n-online']!.agents.map((a) => a.agentId)).toEqual(['a-1'])
  })
})
```

- [ ] **Step 2：运行测试验证失败**

```bash
cd apps/controlplane && pnpm vitest run src/routes/__tests__/debug-nodes.test.ts
```

- [ ] **Step 3：实现路由**

创建 `apps/controlplane/src/routes/debug-nodes.ts`：

```ts
import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { HEARTBEAT_TIMEOUT_MS } from './node-heartbeat.js'

interface NodeRow {
  node_id: string
  hostname: string
  platform: string
  version: string
  execution_state: string
  last_heartbeat_at: number | null
  created_at: number
}

interface AgentRow {
  agent_id: string
  type: string
  name: string
  version: string
}

/**
 * Debug 专用的节点列表：相比 /api/ui/nodes，额外返回 registeredAt 与 ISO 化的 heartbeat 时间，
 * 方便运维人员在 UI 上直接读取。
 */
export function createDebugNodesRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()

  app.get('/api/debug/nodes', (c) => {
    const now = Date.now()
    const rows = db.raw.prepare('SELECT * FROM nodes').all() as NodeRow[]
    const nodes = rows.map((n) => {
      const status =
        n.last_heartbeat_at !== null && now - n.last_heartbeat_at < HEARTBEAT_TIMEOUT_MS
          ? 'online'
          : 'offline'
      const agents = db.raw
        .prepare('SELECT agent_id, type, name, version FROM agents WHERE node_id = ?')
        .all(n.node_id) as AgentRow[]
      return {
        nodeId: n.node_id,
        hostname: n.hostname,
        platform: n.platform,
        version: n.version,
        status,
        executionState: n.execution_state,
        lastHeartbeatAt:
          n.last_heartbeat_at !== null ? new Date(n.last_heartbeat_at).toISOString() : null,
        registeredAt: new Date(n.created_at).toISOString(),
        agents: agents.map((a) => ({
          agentId: a.agent_id,
          type: a.type,
          name: a.name,
          version: a.version,
        })),
      }
    })
    return c.json({ nodes })
  })

  return app
}
```

- [ ] **Step 4：再跑测试并通过**

```bash
cd apps/controlplane && pnpm vitest run src/routes/__tests__/debug-nodes.test.ts
```

- [ ] **Step 5：`pnpm check` 修复问题**

```bash
pnpm check
```

- [ ] **Step 6：提交**

```bash
git add apps/controlplane/src/routes/debug-nodes.ts apps/controlplane/src/routes/__tests__/debug-nodes.test.ts
git commit -m "feat(controlplane): 新增 /api/debug/nodes 节点运维状态接口

与 /api/ui/nodes 区别：额外返回 registeredAt 与 ISO 化的 lastHeartbeatAt，面向 Debug UI 使用。"
```

---

## Task 3: `app.ts` 条件挂载 debug 路由组

**Files:**
- Modify: `apps/controlplane/src/app.ts`
- Create: `apps/controlplane/src/routes/__tests__/debug-mount.test.ts`

**范围：** 仅当 `process.env.TIANJI_DEBUG === 'true'` 时挂载两条新路由；未设置时接口返回 404。

- [ ] **Step 1：写挂载行为失败测试**

创建 `apps/controlplane/src/routes/__tests__/debug-mount.test.ts`：

```ts
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createApp } from '../../app.js'
import { SCHEMA_SQL } from '../../db/schema.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(SCHEMA_SQL)
  return { raw } as unknown as Parameters<typeof createApp>[0]
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as unknown as Parameters<typeof createApp>[1]

describe('TIANJI_DEBUG 条件挂载', () => {
  beforeEach(() => {
    vi.stubEnv('TIANJI_DEBUG', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('未设置 TIANJI_DEBUG 时 /api/debug/* 返回 404', async () => {
    const { app } = createApp(makeDb(), noopLogger)
    const events = await app.request('/api/debug/events?mode=realtime')
    const nodes = await app.request('/api/debug/nodes')
    expect(events.status).toBe(404)
    expect(nodes.status).toBe(404)
  })

  test('TIANJI_DEBUG=true 时 /api/debug/* 可访问', async () => {
    vi.stubEnv('TIANJI_DEBUG', 'true')
    const { app } = createApp(makeDb(), noopLogger)
    const events = await app.request('/api/debug/events?mode=realtime')
    const nodes = await app.request('/api/debug/nodes')
    expect(events.status).toBe(200)
    expect(nodes.status).toBe(200)
  })
})
```

- [ ] **Step 2：运行测试验证失败**

```bash
cd apps/controlplane && pnpm vitest run src/routes/__tests__/debug-mount.test.ts
```

- [ ] **Step 3：修改 `app.ts` 增加条件挂载**

在 `apps/controlplane/src/app.ts` 顶部 import 区追加（与现有 route import 并列，按字母序插入即可）：

```ts
import { createDebugEventsRoute } from './routes/debug-events.js'
import { createDebugNodesRoute } from './routes/debug-nodes.js'
```

**挂载位置：** 必须在 `createWebUiRoute()` 挂载之前（因为 `createWebUiRoute` 内部注册了 `app.get('*', …)` 的 SPA 兜底，虽然它对 `/api/*` 显式返回 404，但为了语义清晰和防止未来修改兜底逻辑误吞，debug 路由必须先于它注册）。选择在 `createCopilotRoute(...)` 这一行之后、`createWebUiRoute()` 这一行之前插入。

当前 `apps/controlplane/src/app.ts` 中的锚点上下文：

```ts
  app.route('/', createUiNodesRoute(db))
  app.route('/', createCopilotRoute(db, logger, bus))
  app.route('/', createWebUiRoute())
```

改成：

```ts
  app.route('/', createUiNodesRoute(db))
  app.route('/', createCopilotRoute(db, logger, bus))
  if (process.env.TIANJI_DEBUG === 'true') {
    app.route('/', createDebugEventsRoute(db))
    app.route('/', createDebugNodesRoute(db))
  }
  app.route('/', createWebUiRoute())
```

- [ ] **Step 4：再跑测试并通过**

```bash
cd apps/controlplane && pnpm vitest run src/routes/__tests__/debug-mount.test.ts
```

- [ ] **Step 5：全量测试（确保没破坏现有路由）**

```bash
cd apps/controlplane && pnpm vitest run
```

- [ ] **Step 6：`pnpm check`**

```bash
pnpm check
```

- [ ] **Step 7：提交**

```bash
git add apps/controlplane/src/app.ts apps/controlplane/src/routes/__tests__/debug-mount.test.ts
git commit -m "feat(controlplane): 通过 TIANJI_DEBUG 环境变量条件挂载 debug 路由组

生产环境默认不设置该变量，/api/debug/* 返回 404；开发环境显式设置 TIANJI_DEBUG=true 启用。"
```

---

## Task 4: 前端 debug-api service 与 debug-store

**Files:**
- Create: `apps/controlplane/src/web/services/debug-api.ts`
- Create: `apps/controlplane/src/web/stores/debug-store.ts`
- Create: `apps/controlplane/src/web/stores/__tests__/debug-store.test.ts`

**范围：** 封装 REST 调用与响应类型；Zustand store 管理面板开关、当前 Tab、模式、过滤条件、事件列表、游标、轮询状态与熔断计数。

- [ ] **Step 1：写 store 业务行为失败测试**

创建 `apps/controlplane/src/web/stores/__tests__/debug-store.test.ts`：

```ts
import { describe, expect, test } from 'vitest'

import { useDebugStore, MAX_EVENTS, FAILURE_THRESHOLD } from '../debug-store.js'
import type { DebugEvent } from '../../services/debug-api.js'

function reset() {
  useDebugStore.getState().reset()
}

function makeEvent(cursor: number): DebugEvent {
  return {
    eventId: `e-${cursor}`,
    type: 'RunStarted',
    occurredAt: new Date().toISOString(),
    correlationId: 'c',
    causationId: null,
    sequence: cursor,
    aggregateType: 'Run',
    aggregateId: 'r-1',
    source: { processKind: 'daemon', processId: 'p-1' },
    payload: {},
    cursor,
  }
}

describe('debug-store 事件列表', () => {
  test('prependEvents 保持降序且不超过 MAX_EVENTS', () => {
    reset()
    const old = Array.from({ length: MAX_EVENTS }, (_, i) => makeEvent(i + 1)).reverse()
    useDebugStore.getState().prependEvents(old, MAX_EVENTS)
    useDebugStore.getState().prependEvents([makeEvent(MAX_EVENTS + 1)], MAX_EVENTS + 1)
    const events = useDebugStore.getState().events
    expect(events).toHaveLength(MAX_EVENTS)
    expect(events[0]!.cursor).toBe(MAX_EVENTS + 1)
    expect(events.at(-1)!.cursor).toBe(2)
  })

  test('过滤条件变更会重置事件列表与游标', () => {
    reset()
    useDebugStore.getState().prependEvents([makeEvent(5), makeEvent(4)], 5)
    useDebugStore.getState().setAggregateType('Session')
    expect(useDebugStore.getState().events).toHaveLength(0)
    expect(useDebugStore.getState().sinceCursor).toBeNull()
  })

  test('prependEvents 按 cursor 去重，不会出现重复行', () => {
    reset()
    useDebugStore.getState().prependEvents([makeEvent(3), makeEvent(2), makeEvent(1)], 3)
    // 同一条 cursor=3 又回流一次（bootstrap + 增量重叠场景）
    useDebugStore.getState().prependEvents([makeEvent(4), makeEvent(3)], 4)
    const cursors = useDebugStore.getState().events.map((e) => e.cursor)
    expect(cursors).toEqual([4, 3, 2, 1])
  })
})

describe('debug-store 熔断', () => {
  test('连续 FAILURE_THRESHOLD 次失败后切换到暂停态', () => {
    reset()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      useDebugStore.getState().reportFailure('net')
    }
    expect(useDebugStore.getState().paused).toBe(true)
    expect(useDebugStore.getState().lastError).toContain('net')
  })

  test('resume 会清零失败计数并解除暂停', () => {
    reset()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      useDebugStore.getState().reportFailure('net')
    }
    useDebugStore.getState().resume()
    expect(useDebugStore.getState().paused).toBe(false)
    expect(useDebugStore.getState().consecutiveFailures).toBe(0)
  })
})
```

- [ ] **Step 2：运行测试验证失败**

```bash
cd apps/controlplane && pnpm vitest run src/web/stores/__tests__/debug-store.test.ts
```

- [ ] **Step 3：实现 debug-api service**

创建 `apps/controlplane/src/web/services/debug-api.ts`：

```ts
export interface DebugEvent {
  eventId: string
  type: string
  occurredAt: string
  correlationId: string
  causationId: string | null
  sequence: number
  aggregateType: 'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node'
  aggregateId: string
  source: { processKind: 'daemon' | 'node' | 'cp'; processId: string; nodeId?: string }
  payload: Record<string, unknown>
  cursor: number
}

export interface DebugEventsResponse {
  events: DebugEvent[]
  maxCursor: number
  minCursor: number
  hasMore: boolean
}

export interface DebugNodeDto {
  nodeId: string
  hostname: string
  platform: string
  version: string
  status: 'online' | 'offline'
  executionState: string
  lastHeartbeatAt: string | null
  registeredAt: string
  agents: Array<{ agentId: string; type: string; name: string; version: string }>
}

export interface FetchEventsParams {
  mode: 'realtime' | 'history'
  sinceCursor?: number
  beforeCursor?: number
  startTime?: string
  endTime?: string
  aggregateType?: 'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node'
  aggregateId?: string
  limit?: number
}

function toQuery(params: FetchEventsParams): string {
  const u = new URLSearchParams()
  u.set('mode', params.mode)
  if (params.sinceCursor !== undefined) u.set('since_cursor', String(params.sinceCursor))
  if (params.beforeCursor !== undefined) u.set('before_cursor', String(params.beforeCursor))
  if (params.startTime !== undefined) u.set('start_time', params.startTime)
  if (params.endTime !== undefined) u.set('end_time', params.endTime)
  if (params.aggregateType !== undefined) u.set('aggregate_type', params.aggregateType)
  if (params.aggregateId !== undefined) u.set('aggregate_id', params.aggregateId)
  if (params.limit !== undefined) u.set('limit', String(params.limit))
  return u.toString()
}

export async function fetchDebugEvents(params: FetchEventsParams): Promise<DebugEventsResponse> {
  const res = await fetch(`/api/debug/events?${toQuery(params)}`)
  if (!res.ok) throw new Error(`debug events ${res.status}`)
  return (await res.json()) as DebugEventsResponse
}

export async function fetchDebugNodes(): Promise<DebugNodeDto[]> {
  const res = await fetch('/api/debug/nodes')
  if (!res.ok) throw new Error(`debug nodes ${res.status}`)
  const body = (await res.json()) as { nodes: DebugNodeDto[] }
  return body.nodes
}
```

- [ ] **Step 4：实现 debug-store**

创建 `apps/controlplane/src/web/stores/debug-store.ts`：

```ts
import { create } from 'zustand'

import type { DebugEvent } from '../services/debug-api.js'

export const MAX_EVENTS = 3000
export const FAILURE_THRESHOLD = 3

export type DebugTab = 'events' | 'nodes'
export type DebugMode = 'realtime' | 'history'
export type AggregateType = 'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node'

export interface DebugState {
  panelOpen: boolean
  tab: DebugTab
  mode: DebugMode

  aggregateType: AggregateType | null
  aggregateId: string
  startTime: string
  endTime: string

  events: DebugEvent[]
  sinceCursor: number | null
  historyReachedEnd: boolean
  historyMinCursor: number | null

  paused: boolean
  consecutiveFailures: number
  lastError: string | null

  togglePanel: () => void
  setTab: (tab: DebugTab) => void
  setMode: (mode: DebugMode) => void
  setAggregateType: (t: AggregateType | null) => void
  setAggregateId: (id: string) => void
  setTimeRange: (start: string, end: string) => void

  prependEvents: (newer: DebugEvent[], newMaxCursor: number) => void
  appendEvents: (older: DebugEvent[], newMinCursor: number, hasMore: boolean) => void
  clearEvents: () => void

  reportFailure: (reason: string) => void
  reportSuccess: () => void
  pause: () => void
  resume: () => void

  reset: () => void
}

const initial = {
  panelOpen: false,
  tab: 'events' as DebugTab,
  mode: 'realtime' as DebugMode,
  aggregateType: null as AggregateType | null,
  aggregateId: '',
  startTime: '',
  endTime: '',
  events: [] as DebugEvent[],
  sinceCursor: null as number | null,
  historyReachedEnd: false,
  historyMinCursor: null as number | null,
  paused: false,
  consecutiveFailures: 0,
  lastError: null as string | null,
}

function resetListOnFilterChange<T extends object>(patch: T) {
  return {
    ...patch,
    events: [] as DebugEvent[],
    sinceCursor: null,
    historyReachedEnd: false,
    historyMinCursor: null,
  }
}

export const useDebugStore = create<DebugState>((set) => ({
  ...initial,

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setTab: (tab) => set({ tab }),
  setMode: (mode) => set(resetListOnFilterChange({ mode })),
  setAggregateType: (t) => set(resetListOnFilterChange({ aggregateType: t })),
  setAggregateId: (id) => set(resetListOnFilterChange({ aggregateId: id })),
  setTimeRange: (startTime, endTime) => set(resetListOnFilterChange({ startTime, endTime })),

  // newer：按 cursor 降序的新事件数组（最新在前）。
  // 按 cursor 去重：若某事件的 cursor 已在当前列表中，跳过该条（处理实时增量与 bootstrap 重叠）。
  prependEvents: (newer, newMaxCursor) =>
    set((s) => {
      if (newer.length === 0) {
        return { sinceCursor: Math.max(s.sinceCursor ?? 0, newMaxCursor) }
      }
      const existing = new Set(s.events.map((e) => e.cursor))
      const deduped = newer.filter((e) => !existing.has(e.cursor))
      if (deduped.length === 0) {
        return { sinceCursor: Math.max(s.sinceCursor ?? 0, newMaxCursor) }
      }
      const merged = [...deduped, ...s.events].slice(0, MAX_EVENTS)
      return { events: merged, sinceCursor: Math.max(s.sinceCursor ?? 0, newMaxCursor) }
    }),
  // older：按 cursor 降序的更老事件数组（追加到列表尾部）。
  // 场景 1：历史模式第一页（Toolbar clearEvents() 后调用，此时 events 为空，直接写入）。
  // 场景 2：滚动触底分页（events 非空，将更老的数据接到尾部）。
  appendEvents: (older, newMinCursor, hasMore) =>
    set((s) => {
      const existing = new Set(s.events.map((e) => e.cursor))
      const deduped = older.filter((e) => !existing.has(e.cursor))
      const merged = [...s.events, ...deduped].slice(0, MAX_EVENTS)
      return {
        events: merged,
        historyMinCursor: newMinCursor,
        historyReachedEnd: !hasMore,
      }
    }),
  clearEvents: () =>
    set({ events: [], sinceCursor: null, historyReachedEnd: false, historyMinCursor: null }),

  reportFailure: (reason) =>
    set((s) => {
      const next = s.consecutiveFailures + 1
      return {
        consecutiveFailures: next,
        lastError: reason,
        paused: next >= FAILURE_THRESHOLD ? true : s.paused,
      }
    }),
  reportSuccess: () => set({ consecutiveFailures: 0, lastError: null }),
  pause: () => set({ paused: true }),
  resume: () => set({ paused: false, consecutiveFailures: 0, lastError: null }),

  reset: () => set(initial),
}))
```

- [ ] **Step 5：再跑测试通过**

```bash
cd apps/controlplane && pnpm vitest run src/web/stores/__tests__/debug-store.test.ts
```

- [ ] **Step 6：`pnpm check`**

```bash
pnpm check
```

- [ ] **Step 7：提交**

```bash
git add apps/controlplane/src/web/services/debug-api.ts apps/controlplane/src/web/stores/debug-store.ts apps/controlplane/src/web/stores/__tests__/debug-store.test.ts
git commit -m "feat(controlplane): 新增 debug-api service 与 debug-store

封装 /api/debug/events 与 /api/debug/nodes 的 fetch 调用和响应类型；Zustand store 管理面板开关、
Tab、模式、过滤器、事件列表（上限 3000）、游标、熔断（3 次连失自动暂停）。"
```

---

## Task 5: 浮动窗口骨架（use-debug-window + DebugToggleButton + DebugPanel）

**Files:**
- Create: `apps/controlplane/src/web/components/debug/hooks/use-debug-window.ts`
- Create: `apps/controlplane/src/web/components/debug/debug-toggle-button.tsx`
- Create: `apps/controlplane/src/web/components/debug/debug-panel.tsx`
- Create: `apps/controlplane/src/web/components/debug/__tests__/debug-panel.test.tsx`

**范围：** Hook 封装拖拽 + 调整大小 + 最小化的位置/尺寸状态；`DebugToggleButton` 仅当 `import.meta.env.VITE_ENABLE_DEBUG === 'true'` 时返回按钮，否则返回 `null`；`DebugPanel` 依据 store 的 `panelOpen` 决定显隐，内部容器用 hook 提供的 style。

- [ ] **Step 1：写组件渲染测试**

创建 `apps/controlplane/src/web/components/debug/__tests__/debug-panel.test.tsx`：

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, test, beforeEach } from 'vitest'

import { DebugPanelImpl } from '../debug-panel.js'
import { DebugToggleButtonImpl } from '../debug-toggle-button.js'
import { useDebugStore } from '../../../stores/debug-store.js'

beforeEach(() => {
  useDebugStore.getState().reset()
})

describe('DebugToggleButtonImpl', () => {
  // 直接测试 Impl 函数，不走 DEBUG_ENABLED wrapper。
  // wrapper 的负分支（tree-shake 掉）由 Task 10 的 grep dist/ 验证。
  test('点击按钮切换面板开关', () => {
    render(<DebugToggleButtonImpl />)
    const btn = screen.getByRole('button', { name: /debug/i })
    fireEvent.click(btn)
    expect(useDebugStore.getState().panelOpen).toBe(true)
    fireEvent.click(btn)
    expect(useDebugStore.getState().panelOpen).toBe(false)
  })
})

describe('DebugPanelImpl', () => {
  test('panelOpen 为 false 时不渲染内容容器', () => {
    render(<DebugPanelImpl />)
    expect(screen.queryByTestId('debug-panel-content')).toBeNull()
  })

  test('panelOpen 为 true 时渲染内容容器', () => {
    useDebugStore.getState().togglePanel()
    render(<DebugPanelImpl />)
    expect(screen.getByTestId('debug-panel-content')).not.toBeNull()
  })
})
```

- [ ] **Step 2：运行测试验证失败**

```bash
cd apps/controlplane && pnpm vitest run src/web/components/debug/__tests__/debug-panel.test.tsx
```

- [ ] **Step 3：实现 use-debug-window hook**

创建 `apps/controlplane/src/web/components/debug/hooks/use-debug-window.ts`：

```ts
import { useCallback, useState } from 'react'

export interface WindowGeom {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 窗口拖拽 + 大小调整 + 最小化的几何状态管理。
 * 不负责具体渲染，只暴露 style 与事件 handler。
 */
export function useDebugWindow(initial: WindowGeom) {
  const [geom, setGeom] = useState<WindowGeom>(initial)
  const [minimized, setMinimized] = useState(false)

  const onDrag = useCallback((dx: number, dy: number) => {
    setGeom((g) => ({ ...g, x: g.x + dx, y: g.y + dy }))
  }, [])

  const onResize = useCallback((dw: number, dh: number) => {
    setGeom((g) => ({
      ...g,
      width: Math.max(400, g.width + dw),
      height: Math.max(300, g.height + dh),
    }))
  }, [])

  const toggleMinimize = useCallback(() => setMinimized((m) => !m), [])

  const style: React.CSSProperties = {
    position: 'fixed',
    left: geom.x,
    top: geom.y,
    width: geom.width,
    height: minimized ? 40 : geom.height,
    zIndex: 9999,
  }

  return { geom, minimized, style, onDrag, onResize, toggleMinimize }
}
```

- [ ] **Step 4：实现 DebugToggleButton**

创建 `apps/controlplane/src/web/components/debug/debug-toggle-button.tsx`：

```tsx
import { useDebugStore } from '../../stores/debug-store.js'

/**
 * 判断在模块顶层完成，值在 build 时被 Vite 内联为常量 false 或 true。
 * 这样 `DEBUG_ENABLED ? DebugToggleButtonImpl : EmptyComponent` 在 DEBUG_ENABLED=false 时
 * 让 DebugToggleButtonImpl 变成未被引用的 binding，rollup DCE 可以连同它的内部依赖一起剔除。
 */
const DEBUG_ENABLED = import.meta.env.VITE_ENABLE_DEBUG === 'true'

/**
 * 真正的实现。导出以便测试文件直接验证其渲染/点击行为，绕开模块级 DEBUG_ENABLED 常量
 * 在 test 环境无法运行时切换的限制（vi.stubEnv 无法重置已经计算好的 const）。
 */
export function DebugToggleButtonImpl(): JSX.Element {
  const togglePanel = useDebugStore((s) => s.togglePanel)
  return (
    <button
      type="button"
      onClick={togglePanel}
      aria-label="Debug"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 9999,
        padding: '8px 12px',
        borderRadius: 8,
        border: '1px solid #333',
        background: '#111',
        color: '#fff',
      }}
    >
      Debug
    </button>
  )
}

function EmptyComponent(): null {
  return null
}

/**
 * 右下角的 Debug 开关。仅当 VITE_ENABLE_DEBUG === 'true' 时才导出真正的实现，
 * 否则导出一个静态返回 null 的空组件；实现函数与其依赖被 Vite tree-shake。
 */
export const DebugToggleButton = DEBUG_ENABLED ? DebugToggleButtonImpl : EmptyComponent
```

**注意：** `DEBUG_ENABLED` 写成模块顶层 `const`，不是 `DebugToggleButtonImpl` 内部的条件 return，原因有两个：
1. React Hooks 规则禁止"条件 return 在 hook 调用之前"。条件 return + 调用 `useDebugStore` 会让 `pnpm check` 的 eslint-plugin-react-hooks 报错。
2. 为让 Vite build 阶段把 `DEBUG_ENABLED` 替换为常量 false，从而把整棵 `DebugToggleButtonImpl`（含其所有 import）当作死代码消除。

- [ ] **Step 5：实现 DebugPanel 骨架（内容留白，后续 Task 补）**

创建 `apps/controlplane/src/web/components/debug/debug-panel.tsx`：

```tsx
import { useDebugStore } from '../../stores/debug-store.js'
import { useDebugWindow } from './hooks/use-debug-window.js'

const DEBUG_ENABLED = import.meta.env.VITE_ENABLE_DEBUG === 'true'

/**
 * 真正的实现。导出以便测试文件直接渲染，绕开模块级 DEBUG_ENABLED 常量在测试
 * 环境中无法运行时切换的限制。
 */
export function DebugPanelImpl(): JSX.Element | null {
  const open = useDebugStore((s) => s.panelOpen)
  const { style } = useDebugWindow({ x: 100, y: 100, width: 800, height: 500 })
  if (!open) return null
  return (
    <div
      data-testid="debug-panel-content"
      style={{ ...style, background: '#1a1a1a', color: '#eee', border: '1px solid #333', borderRadius: 8 }}
    >
      {/* Toolbar 与 TabContent 由后续 Task 填入 */}
    </div>
  )
}

function EmptyComponent(): null {
  return null
}

/**
 * 浮动调试面板容器。仅当 VITE_ENABLE_DEBUG === 'true' 时导出真正实现。
 * DEBUG_ENABLED=false 时，DebugPanelImpl 未被作为 default export 引用，rollup 会连同它引入的
 * use-debug-window、后续 Task 新增的 DebugToolbar / EventListTab / NodeStatusTab / use-event-polling
 * 一起剔除。**注意：`DebugPanelImpl` 是 named export，仅用于测试直接渲染；生产代码只引用 `DebugPanel`。**
 */
export const DebugPanel = DEBUG_ENABLED ? DebugPanelImpl : EmptyComponent
```

**注意：** 这里的 `DEBUG_ENABLED` 与 `DebugToggleButton` 中的写法必须完全一致（相同字面量），避免 Vite 替换后出现两套布尔判断分支。Task 9 修改本文件时只改 `DebugPanelImpl` 内部，不改外层 wrapper。

- [ ] **Step 6：再跑测试并通过**

```bash
cd apps/controlplane && pnpm vitest run src/web/components/debug/__tests__/debug-panel.test.tsx
```

- [ ] **Step 7：`pnpm check`**

```bash
pnpm check
```

- [ ] **Step 8：提交**

```bash
git add apps/controlplane/src/web/components/debug/
git commit -m "feat(controlplane): 新增 DebugToggleButton / DebugPanel 浮动窗口骨架

use-debug-window hook 管理位置与大小；DebugToggleButton 严格按 VITE_ENABLE_DEBUG === 'true'
判断渲染，生产构建可被 tree-shake。"
```

---

## Task 6: 实时轮询 Hook（use-event-polling）

**Files:**
- Create: `apps/controlplane/src/web/components/debug/hooks/use-event-polling.ts`
- Create: `apps/controlplane/src/web/components/debug/hooks/__tests__/use-event-polling.test.tsx`

**范围：** 挂载时 Bootstrap（不带 `since_cursor`），之后每 2 秒调用一次增量接口；过滤条件变更由 store 清空列表触发重新 bootstrap；连续 3 次失败后 `reportFailure` 自动暂停。

- [ ] **Step 1：写失败测试（用假 fetch + fake timer）**

创建 `apps/controlplane/src/web/components/debug/hooks/__tests__/use-event-polling.test.tsx`：

```tsx
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { useDebugStore } from '../../../../stores/debug-store.js'
import * as api from '../../../../services/debug-api.js'
import { useEventPolling } from '../use-event-polling.js'

beforeEach(() => {
  useDebugStore.getState().reset()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function mockEvent(cursor: number): api.DebugEvent {
  return {
    eventId: `e-${cursor}`,
    type: 'RunStarted',
    occurredAt: new Date().toISOString(),
    correlationId: 'c',
    causationId: null,
    sequence: cursor,
    aggregateType: 'Run',
    aggregateId: 'r',
    source: { processKind: 'daemon', processId: 'p' },
    payload: {},
    cursor,
  }
}

describe('useEventPolling', () => {
  test('挂载时 bootstrap 不带 sinceCursor', async () => {
    const spy = vi
      .spyOn(api, 'fetchDebugEvents')
      .mockResolvedValue({ events: [mockEvent(3), mockEvent(2)], maxCursor: 3, minCursor: 2, hasMore: false })
    useDebugStore.setState({ panelOpen: true, tab: 'events', mode: 'realtime' })
    renderHook(() => useEventPolling())
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls[0]![0]).toMatchObject({ mode: 'realtime' })
    expect(spy.mock.calls[0]![0].sinceCursor).toBeUndefined()
  })

  test('每 2 秒轮询一次并带上 sinceCursor', async () => {
    vi.spyOn(api, 'fetchDebugEvents').mockResolvedValue({
      events: [mockEvent(5)],
      maxCursor: 5,
      minCursor: 5,
      hasMore: false,
    })
    useDebugStore.setState({ panelOpen: true, tab: 'events', mode: 'realtime' })
    renderHook(() => useEventPolling())
    await waitFor(() => expect(useDebugStore.getState().sinceCursor).toBe(5))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect((api.fetchDebugEvents as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2)
    const lastCall = (api.fetchDebugEvents as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
    expect(lastCall.sinceCursor).toBe(5)
  })

  test('连续 3 次失败后 store.paused 变 true', async () => {
    vi.spyOn(api, 'fetchDebugEvents').mockRejectedValue(new Error('net'))
    useDebugStore.setState({ panelOpen: true, tab: 'events', mode: 'realtime' })
    renderHook(() => useEventPolling())
    // bootstrap 失败 → failure 1
    await waitFor(() => expect(useDebugStore.getState().consecutiveFailures).toBeGreaterThanOrEqual(1))
    // 显式推进 3 次 2s tick，避免失败计数与 interval 的竞态。
    // 2s tick → failure 2；2s tick → failure 3（paused=true，effect cleanup）；
    // 第 3 次推进用于确保即使 cleanup 有延迟，也不会继续累加失败。
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
    }
    await waitFor(() => expect(useDebugStore.getState().paused).toBe(true))
  })

  test('切到非 events tab 时停止轮询', async () => {
    const spy = vi.spyOn(api, 'fetchDebugEvents').mockResolvedValue({
      events: [],
      maxCursor: 0,
      minCursor: 0,
      hasMore: false,
    })
    useDebugStore.setState({ panelOpen: true, tab: 'events', mode: 'realtime' })
    renderHook(() => useEventPolling())
    await waitFor(() => expect(spy).toHaveBeenCalled())
    const baseline = spy.mock.calls.length
    useDebugStore.getState().setTab('nodes')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(spy.mock.calls.length).toBe(baseline)
  })
})
```

- [ ] **Step 2：运行测试验证失败**

```bash
cd apps/controlplane && pnpm vitest run src/web/components/debug/hooks/__tests__/use-event-polling.test.tsx
```

- [ ] **Step 3：实现 hook**

创建 `apps/controlplane/src/web/components/debug/hooks/use-event-polling.ts`：

```ts
import { useEffect, useRef } from 'react'

import { fetchDebugEvents } from '../../../services/debug-api.js'
import { useDebugStore } from '../../../stores/debug-store.js'

const POLL_INTERVAL_MS = 2000

/**
 * 实时模式的轮询驱动。
 * - 激活条件：panelOpen && tab === 'events' && mode === 'realtime' && !paused
 * - 挂载 / 激活条件变化时：不带 sinceCursor 触发 bootstrap
 * - 之后每 2 秒一次增量请求
 * - 失败累计 FAILURE_THRESHOLD 次后由 store 自动切 paused
 */
export function useEventPolling(): void {
  const active = useDebugStore(
    (s) => s.panelOpen && s.tab === 'events' && s.mode === 'realtime' && !s.paused
  )
  const sinceCursor = useDebugStore((s) => s.sinceCursor)
  const aggregateType = useDebugStore((s) => s.aggregateType)
  const aggregateId = useDebugStore((s) => s.aggregateId)
  const prependEvents = useDebugStore((s) => s.prependEvents)
  const reportFailure = useDebugStore((s) => s.reportFailure)
  const reportSuccess = useDebugStore((s) => s.reportSuccess)

  const cursorRef = useRef<number | null>(null)
  cursorRef.current = sinceCursor

  useEffect(() => {
    if (!active) return
    let cancelled = false

    async function tick(isBootstrap: boolean): Promise<void> {
      try {
        const res = await fetchDebugEvents({
          mode: 'realtime',
          sinceCursor: isBootstrap ? undefined : (cursorRef.current ?? undefined),
          aggregateType: aggregateType ?? undefined,
          aggregateId: aggregateId === '' ? undefined : aggregateId,
          limit: isBootstrap ? 100 : 500,
        })
        if (cancelled) return
        if (res.events.length > 0 || isBootstrap) {
          prependEvents(res.events, res.maxCursor || cursorRef.current || 0)
        }
        reportSuccess()
      } catch (e) {
        if (cancelled) return
        reportFailure(e instanceof Error ? e.message : 'unknown')
      }
    }

    void tick(true)
    const id = setInterval(() => {
      void tick(false)
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [active, aggregateType, aggregateId, prependEvents, reportFailure, reportSuccess])
}
```

- [ ] **Step 4：再跑测试并通过**

```bash
cd apps/controlplane && pnpm vitest run src/web/components/debug/hooks/__tests__/use-event-polling.test.tsx
```

- [ ] **Step 5：`pnpm check`**

```bash
pnpm check
```

- [ ] **Step 6：提交**

```bash
git add apps/controlplane/src/web/components/debug/hooks/
git commit -m "feat(controlplane): 新增 use-event-polling hook

挂载即 bootstrap、之后每 2 秒增量；panelOpen / tab / mode / paused 任一变化自动启停；
失败累计 3 次触发 store 自动 paused。"
```

---

## Task 7: 历史滚动分页 Hook + EventListTab + EventDetailDrawer

**Files:**
- Create: `apps/controlplane/src/web/components/debug/hooks/use-history-pagination.ts`
- Create: `apps/controlplane/src/web/components/debug/event-list-tab.tsx`
- Create: `apps/controlplane/src/web/components/debug/event-detail-drawer.tsx`
- Create: `apps/controlplane/src/web/components/debug/__tests__/event-list-tab.test.tsx`

**范围：**
- `use-history-pagination`：只在 mode === 'history' 激活；用户手动触发第一页；滚动到底部（距底 < 200px）触发下一页；`hasMore=false` 后不再触发。
- `EventListTab`：渲染事件列表（降序），展示 banner（lastError / 溢出提示 / 到底提示）；点击事件打开 Drawer。
- `EventDetailDrawer`：展示原始 envelope JSON。

- [ ] **Step 1：写组件业务测试**

创建 `apps/controlplane/src/web/components/debug/__tests__/event-list-tab.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import * as api from '../../../services/debug-api.js'
import { useDebugStore, MAX_EVENTS } from '../../../stores/debug-store.js'
import { EventListTab } from '../event-list-tab.js'

beforeEach(() => useDebugStore.getState().reset())
afterEach(() => vi.restoreAllMocks())

function mockEvent(cursor: number): api.DebugEvent {
  return {
    eventId: `e-${cursor}`,
    type: 'RunStarted',
    occurredAt: new Date().toISOString(),
    correlationId: 'c',
    causationId: null,
    sequence: cursor,
    aggregateType: 'Run',
    aggregateId: 'r',
    source: { processKind: 'daemon', processId: 'p' },
    payload: { hello: 'world' },
    cursor,
  }
}

describe('EventListTab', () => {
  test('渲染事件行按降序（cursor 大的在最上方）', () => {
    useDebugStore.setState({
      panelOpen: true,
      tab: 'events',
      mode: 'history',
      events: [mockEvent(3), mockEvent(2), mockEvent(1)],
    })
    render(<EventListTab />)
    const rows = screen.getAllByTestId('event-row')
    expect(rows).toHaveLength(3)
    // 严格按下标断言顺序（降序：e-3 在 [0]，e-1 在 [2]）
    expect(rows[0]!.textContent).toContain('e-3')
    expect(rows[1]!.textContent).toContain('e-2')
    expect(rows[2]!.textContent).toContain('e-1')
  })

  test('点击事件行打开 Drawer 展示原始 JSON', () => {
    useDebugStore.setState({ panelOpen: true, tab: 'events', mode: 'history', events: [mockEvent(1)] })
    render(<EventListTab />)
    fireEvent.click(screen.getByTestId('event-row'))
    expect(screen.getByTestId('event-detail-json').textContent).toContain('"eventId": "e-1"')
  })

  test('超过 MAX_EVENTS 时显示溢出提示', () => {
    const events = Array.from({ length: MAX_EVENTS }, (_, i) => mockEvent(MAX_EVENTS - i))
    useDebugStore.setState({ panelOpen: true, tab: 'events', mode: 'history', events })
    render(<EventListTab />)
    expect(screen.getByText(/3000/).textContent).toMatch(/上限|缩小/)
  })

  test('lastError 存在时显示红色 banner', () => {
    useDebugStore.setState({
      panelOpen: true,
      tab: 'events',
      mode: 'realtime',
      lastError: 'network down',
    })
    render(<EventListTab />)
    expect(screen.getByRole('alert').textContent).toContain('network down')
  })
})

describe('use-history-pagination 业务行为', () => {
  test('滚动触底调用 fetchDebugEvents 带 beforeCursor', async () => {
    const spy = vi.spyOn(api, 'fetchDebugEvents').mockResolvedValue({
      events: [mockEvent(2), mockEvent(1)],
      maxCursor: 2,
      minCursor: 1,
      hasMore: false,
    })
    useDebugStore.setState({
      panelOpen: true,
      tab: 'events',
      mode: 'history',
      events: [mockEvent(10), mockEvent(9), mockEvent(8)],
      historyMinCursor: 8,
      historyReachedEnd: false,
    })
    render(<EventListTab />)
    const list = screen.getByTestId('event-list-scroll')
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(list, 'scrollTop', { value: 400, configurable: true, writable: true })
    fireEvent.scroll(list)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls.at(-1)![0]).toMatchObject({ mode: 'history', beforeCursor: 8 })
  })

  test('historyMinCursor 为 null 时滚动触底不会发请求', async () => {
    const spy = vi.spyOn(api, 'fetchDebugEvents').mockResolvedValue({
      events: [],
      maxCursor: 0,
      minCursor: 0,
      hasMore: false,
    })
    useDebugStore.setState({
      panelOpen: true,
      tab: 'events',
      mode: 'history',
      events: [mockEvent(10)],
      historyMinCursor: null, // 尚未加载第一页
      historyReachedEnd: false,
    })
    render(<EventListTab />)
    const list = screen.getByTestId('event-list-scroll')
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(list, 'scrollTop', { value: 400, configurable: true, writable: true })
    fireEvent.scroll(list)
    // 显式等一个 microtask 让 handler 跑完
    await Promise.resolve()
    expect(spy).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2：运行测试验证失败**

```bash
cd apps/controlplane && pnpm vitest run src/web/components/debug/__tests__/event-list-tab.test.tsx
```

- [ ] **Step 3：实现 use-history-pagination hook**

创建 `apps/controlplane/src/web/components/debug/hooks/use-history-pagination.ts`：

```ts
import { useCallback } from 'react'

import { fetchDebugEvents } from '../../../services/debug-api.js'
import { useDebugStore } from '../../../stores/debug-store.js'

/**
 * 历史模式的分页加载器。
 * 激活条件：`mode === 'history'` 且尚未到底。
 *
 * 关键守卫：`historyMinCursor === null` 时直接返回（表示尚未加载第一页），
 * 避免没有 before_cursor 就去请求后端导致返回"全库最近 N 条"，语义错乱。
 * 第一页由 Toolbar 的"查询"按钮显式触发（走 appendEvents 写入 historyMinCursor）。
 */
export function useHistoryPagination(): () => Promise<void> {
  const appendEvents = useDebugStore((s) => s.appendEvents)
  const mode = useDebugStore((s) => s.mode)
  const reachedEnd = useDebugStore((s) => s.historyReachedEnd)
  const minCursor = useDebugStore((s) => s.historyMinCursor)
  const aggregateType = useDebugStore((s) => s.aggregateType)
  const aggregateId = useDebugStore((s) => s.aggregateId)
  const startTime = useDebugStore((s) => s.startTime)
  const endTime = useDebugStore((s) => s.endTime)

  return useCallback(async () => {
    if (mode !== 'history' || reachedEnd) return
    if (minCursor === null) return
    const res = await fetchDebugEvents({
      mode: 'history',
      beforeCursor: minCursor,
      startTime: startTime === '' ? undefined : startTime,
      endTime: endTime === '' ? undefined : endTime,
      aggregateType: aggregateType ?? undefined,
      aggregateId: aggregateId === '' ? undefined : aggregateId,
      limit: 200,
    })
    appendEvents(res.events, res.minCursor || minCursor, res.hasMore)
  }, [mode, reachedEnd, minCursor, aggregateType, aggregateId, startTime, endTime, appendEvents])
}
```

- [ ] **Step 4：实现 EventDetailDrawer**

创建 `apps/controlplane/src/web/components/debug/event-detail-drawer.tsx`：

```tsx
import type { DebugEvent } from '../../services/debug-api.js'

interface Props {
  event: DebugEvent | null
  onClose: () => void
}

export function EventDetailDrawer({ event, onClose }: Props): JSX.Element | null {
  if (event === null) return null
  return (
    <div
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: '45%',
        background: '#0f0f0f',
        borderLeft: '1px solid #333',
        padding: 12,
        overflow: 'auto',
      }}
    >
      <button type="button" onClick={onClose} aria-label="关闭详情">
        ×
      </button>
      <pre data-testid="event-detail-json" style={{ margin: 0, fontSize: 12 }}>
        {JSON.stringify(event, null, 2)}
      </pre>
    </div>
  )
}
```

- [ ] **Step 5：实现 EventListTab**

创建 `apps/controlplane/src/web/components/debug/event-list-tab.tsx`：

```tsx
import { useRef, useState } from 'react'

import type { DebugEvent } from '../../services/debug-api.js'
import { useDebugStore, MAX_EVENTS } from '../../stores/debug-store.js'
import { EventDetailDrawer } from './event-detail-drawer.js'
import { useHistoryPagination } from './hooks/use-history-pagination.js'

const SCROLL_THRESHOLD_PX = 200

export function EventListTab(): JSX.Element {
  const events = useDebugStore((s) => s.events)
  const lastError = useDebugStore((s) => s.lastError)
  const reachedEnd = useDebugStore((s) => s.historyReachedEnd)
  const loadMore = useHistoryPagination()
  const [selected, setSelected] = useState<DebugEvent | null>(null)
  const loadingRef = useRef(false)

  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight > SCROLL_THRESHOLD_PX) return
    if (loadingRef.current || reachedEnd) return
    loadingRef.current = true
    loadMore().finally(() => {
      loadingRef.current = false
    })
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      {lastError !== null && (
        <div role="alert" style={{ background: '#5a1f1f', color: '#fff', padding: 6 }}>
          轮询失败：{lastError}
        </div>
      )}
      {events.length >= MAX_EVENTS && (
        <div style={{ background: '#3a3a1f', color: '#fff', padding: 6 }}>
          已加载 3000 条达到上限，如需继续请缩小时间范围。
        </div>
      )}
      <div
        data-testid="event-list-scroll"
        onScroll={onScroll}
        style={{ overflowY: 'auto', height: 'calc(100% - 40px)' }}
      >
        {events.map((ev) => (
          <div
            key={ev.eventId}
            data-testid="event-row"
            onClick={() => setSelected(ev)}
            style={{
              cursor: 'pointer',
              padding: '4px 8px',
              borderBottom: '1px solid #222',
              fontFamily: 'monospace',
              fontSize: 12,
            }}
          >
            {ev.occurredAt} · {ev.type} · {ev.aggregateType} · {ev.aggregateId.slice(0, 12)} · #{ev.cursor} · {ev.eventId}
          </div>
        ))}
        {reachedEnd && <div style={{ padding: 8, color: '#888' }}>已到底部</div>}
      </div>
      <EventDetailDrawer event={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
```

- [ ] **Step 6：再跑测试并通过**

```bash
cd apps/controlplane && pnpm vitest run src/web/components/debug/__tests__/event-list-tab.test.tsx
```

- [ ] **Step 7：`pnpm check`**

```bash
pnpm check
```

- [ ] **Step 8：提交**

```bash
git add apps/controlplane/src/web/components/debug/
git commit -m "feat(controlplane): 新增 EventListTab / EventDetailDrawer 与历史分页 hook

滚动触底（< 200px）加载下一页；命中 MAX_EVENTS / hasMore=false 有明确提示；
点击任一事件右侧弹出 Drawer 展示原始 envelope JSON。"
```

---

## Task 8: NodeStatusTab（含定时刷新）

**Files:**
- Create: `apps/controlplane/src/web/components/debug/node-status-tab.tsx`
- Create: `apps/controlplane/src/web/components/debug/__tests__/node-status-tab.test.tsx`

**范围：** 5 秒刷新一次 `/api/debug/nodes`；只在 `panelOpen && tab === 'nodes'` 时启动定时器，其他状态清理。

- [ ] **Step 1：写组件业务测试**

创建 `apps/controlplane/src/web/components/debug/__tests__/node-status-tab.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import * as api from '../../../services/debug-api.js'
import { useDebugStore } from '../../../stores/debug-store.js'
import { NodeStatusTab } from '../node-status-tab.js'

beforeEach(() => {
  useDebugStore.getState().reset()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('NodeStatusTab', () => {
  test('激活时拉取并展示节点卡片', async () => {
    vi.spyOn(api, 'fetchDebugNodes').mockResolvedValue([
      {
        nodeId: 'n-1',
        hostname: 'h1',
        platform: 'linux',
        version: 'v1',
        status: 'online',
        executionState: 'idle',
        lastHeartbeatAt: new Date().toISOString(),
        registeredAt: new Date().toISOString(),
        agents: [{ agentId: 'a-1', type: 'native', name: 'Agent A', version: 'v1' }],
      },
    ])
    useDebugStore.setState({ panelOpen: true, tab: 'nodes' })
    render(<NodeStatusTab />)
    await vi.waitFor(() => expect(screen.getByText('n-1')).not.toBeNull())
    expect(screen.getByText('a-1')).not.toBeNull()
  })

  test('每 5 秒刷新一次', async () => {
    const spy = vi.spyOn(api, 'fetchDebugNodes').mockResolvedValue([])
    useDebugStore.setState({ panelOpen: true, tab: 'nodes' })
    render(<NodeStatusTab />)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    const baseline = spy.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(spy.mock.calls.length).toBe(baseline + 1)
  })

  test('切到 events tab 后不再刷新', async () => {
    const spy = vi.spyOn(api, 'fetchDebugNodes').mockResolvedValue([])
    useDebugStore.setState({ panelOpen: true, tab: 'nodes' })
    render(<NodeStatusTab />)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    useDebugStore.getState().setTab('events')
    const baseline = spy.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(spy.mock.calls.length).toBe(baseline)
  })
})
```

- [ ] **Step 2：运行测试验证失败**

```bash
cd apps/controlplane && pnpm vitest run src/web/components/debug/__tests__/node-status-tab.test.tsx
```

- [ ] **Step 3：实现 NodeStatusTab**

创建 `apps/controlplane/src/web/components/debug/node-status-tab.tsx`：

```tsx
import { useEffect, useState } from 'react'

import { fetchDebugNodes, type DebugNodeDto } from '../../services/debug-api.js'
import { useDebugStore } from '../../stores/debug-store.js'

const REFRESH_INTERVAL_MS = 5000

export function NodeStatusTab(): JSX.Element {
  const active = useDebugStore((s) => s.panelOpen && s.tab === 'nodes')
  const [nodes, setNodes] = useState<DebugNodeDto[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false

    async function tick(): Promise<void> {
      try {
        const data = await fetchDebugNodes()
        if (!cancelled) {
          setNodes(data)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'unknown')
      }
    }

    void tick()
    const id = setInterval(() => {
      void tick()
    }, REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [active])

  return (
    <div style={{ padding: 8, overflow: 'auto', height: '100%' }}>
      {error !== null && (
        <div role="alert" style={{ background: '#5a1f1f', color: '#fff', padding: 6 }}>
          加载失败：{error}
        </div>
      )}
      {nodes.map((n) => (
        <div
          key={n.nodeId}
          style={{
            border: '1px solid #333',
            borderRadius: 6,
            padding: 8,
            marginBottom: 8,
            fontSize: 12,
            fontFamily: 'monospace',
          }}
        >
          <div style={{ fontWeight: 'bold' }}>{n.nodeId}</div>
          <div>状态：{n.status} · 执行：{n.executionState}</div>
          <div>注册：{n.registeredAt}</div>
          <div>最后心跳：{n.lastHeartbeatAt ?? '-'}</div>
          <div>Agents：</div>
          <ul style={{ margin: '4px 0 0 16px' }}>
            {n.agents.map((a) => (
              <li key={a.agentId}>
                {a.agentId} · {a.name} · {a.type} · {a.version}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 4：再跑测试并通过**

```bash
cd apps/controlplane && pnpm vitest run src/web/components/debug/__tests__/node-status-tab.test.tsx
```

- [ ] **Step 5：`pnpm check`**

```bash
pnpm check
```

- [ ] **Step 6：提交**

```bash
git add apps/controlplane/src/web/components/debug/node-status-tab.tsx apps/controlplane/src/web/components/debug/__tests__/node-status-tab.test.tsx
git commit -m "feat(controlplane): 新增 NodeStatusTab

仅当 panelOpen && tab === 'nodes' 时启用定时器，5 秒刷新一次节点列表；切换 Tab / 关闭面板自动清理。"
```

---

## Task 9: DebugToolbar 与 Panel 组装

**Files:**
- Create: `apps/controlplane/src/web/components/debug/debug-toolbar.tsx`
- Modify: `apps/controlplane/src/web/components/debug/debug-panel.tsx`
- Create: `apps/controlplane/src/web/components/debug/__tests__/debug-toolbar.test.tsx`

**范围：** Toolbar 承载 Tab 切换、模式切换（事件流 Tab 下）、过滤器、时间范围（历史模式下）、暂停/恢复 / 清空 / 熔断后的"恢复"按钮；历史模式下手动触发第一页加载。Panel 按当前 Tab 渲染 EventListTab 或 NodeStatusTab，且两个 Tab 都挂载实时轮询 Hook（hook 内部判断激活条件，自动启停）。

- [ ] **Step 1：写 Toolbar 业务行为测试**

创建 `apps/controlplane/src/web/components/debug/__tests__/debug-toolbar.test.tsx`：

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import * as api from '../../../services/debug-api.js'
import { useDebugStore } from '../../../stores/debug-store.js'
import { DebugToolbar } from '../debug-toolbar.js'

beforeEach(() => useDebugStore.getState().reset())
afterEach(() => vi.restoreAllMocks())

describe('DebugToolbar', () => {
  test('切 Tab 调用 setTab', () => {
    render(<DebugToolbar />)
    fireEvent.click(screen.getByRole('tab', { name: /节点/i }))
    expect(useDebugStore.getState().tab).toBe('nodes')
  })

  test('事件流 Tab 下切模式清空旧列表', () => {
    useDebugStore.setState({ tab: 'events', mode: 'realtime', events: [] })
    render(<DebugToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /历史/i }))
    expect(useDebugStore.getState().mode).toBe('history')
  })

  test('历史模式下点击查询调用 fetchDebugEvents 加载第一页', async () => {
    const spy = vi
      .spyOn(api, 'fetchDebugEvents')
      .mockResolvedValue({ events: [], maxCursor: 0, minCursor: 0, hasMore: false })
    useDebugStore.setState({ tab: 'events', mode: 'history', startTime: '2024-01-01', endTime: '2024-01-02' })
    render(<DebugToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /查询/i }))
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls.at(-1)![0]).toMatchObject({
      mode: 'history',
      startTime: '2024-01-01',
      endTime: '2024-01-02',
    })
  })

  test('熔断后显示恢复按钮并调用 resume', () => {
    useDebugStore.setState({ tab: 'events', mode: 'realtime', paused: true, lastError: 'x' })
    render(<DebugToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /恢复/i }))
    expect(useDebugStore.getState().paused).toBe(false)
  })
})
```

- [ ] **Step 2：运行测试验证失败**

```bash
cd apps/controlplane && pnpm vitest run src/web/components/debug/__tests__/debug-toolbar.test.tsx
```

- [ ] **Step 3：实现 DebugToolbar**

创建 `apps/controlplane/src/web/components/debug/debug-toolbar.tsx`：

```tsx
import { fetchDebugEvents } from '../../services/debug-api.js'
import { useDebugStore, type AggregateType } from '../../stores/debug-store.js'

const AGGREGATE_TYPES: AggregateType[] = ['Session', 'GraphRun', 'Run', 'Task', 'Node']

export function DebugToolbar(): JSX.Element {
  const tab = useDebugStore((s) => s.tab)
  const mode = useDebugStore((s) => s.mode)
  const paused = useDebugStore((s) => s.paused)
  const aggregateType = useDebugStore((s) => s.aggregateType)
  const aggregateId = useDebugStore((s) => s.aggregateId)
  const startTime = useDebugStore((s) => s.startTime)
  const endTime = useDebugStore((s) => s.endTime)

  const setTab = useDebugStore((s) => s.setTab)
  const setMode = useDebugStore((s) => s.setMode)
  const setAggregateType = useDebugStore((s) => s.setAggregateType)
  const setAggregateId = useDebugStore((s) => s.setAggregateId)
  const setTimeRange = useDebugStore((s) => s.setTimeRange)
  const clearEvents = useDebugStore((s) => s.clearEvents)
  const pause = useDebugStore((s) => s.pause)
  const resume = useDebugStore((s) => s.resume)
  const appendEvents = useDebugStore((s) => s.appendEvents)

  async function runHistoryQuery(): Promise<void> {
    clearEvents()
    const res = await fetchDebugEvents({
      mode: 'history',
      startTime: startTime === '' ? undefined : startTime,
      endTime: endTime === '' ? undefined : endTime,
      aggregateType: aggregateType ?? undefined,
      aggregateId: aggregateId === '' ? undefined : aggregateId,
      limit: 200,
    })
    appendEvents(res.events, res.minCursor, res.hasMore)
  }

  return (
    <div style={{ display: 'flex', gap: 8, padding: 6, borderBottom: '1px solid #333', flexWrap: 'wrap' }}>
      <div role="tablist">
        <button role="tab" aria-selected={tab === 'events'} onClick={() => setTab('events')}>事件流</button>
        <button role="tab" aria-selected={tab === 'nodes'} onClick={() => setTab('nodes')}>节点状态</button>
      </div>
      {tab === 'events' && (
        <>
          <button onClick={() => setMode('realtime')} aria-pressed={mode === 'realtime'}>实时</button>
          <button onClick={() => setMode('history')} aria-pressed={mode === 'history'}>历史</button>
          <select
            value={aggregateType ?? ''}
            onChange={(e) => setAggregateType(e.target.value === '' ? null : (e.target.value as AggregateType))}
          >
            <option value="">全部类型</option>
            {AGGREGATE_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            placeholder="aggregate_id"
            value={aggregateId}
            onChange={(e) => setAggregateId(e.target.value)}
          />
          {mode === 'history' && (
            <>
              <input
                type="text"
                placeholder="start_time ISO"
                value={startTime}
                onChange={(e) => setTimeRange(e.target.value, endTime)}
              />
              <input
                type="text"
                placeholder="end_time ISO"
                value={endTime}
                onChange={(e) => setTimeRange(startTime, e.target.value)}
              />
              <button onClick={() => void runHistoryQuery()}>查询</button>
            </>
          )}
          {mode === 'realtime' &&
            (paused ? (
              <button onClick={resume}>恢复</button>
            ) : (
              <button onClick={pause}>暂停</button>
            ))}
          <button onClick={clearEvents}>清空</button>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 4：修改 DebugPanel 组装 Toolbar + Tab 内容 + 轮询 hook**

**保留 Task 5 写入的 `DEBUG_ENABLED` 常量与 `export const DebugPanel = DEBUG_ENABLED ? DebugPanelImpl : EmptyComponent` 外层 wrapper**，只替换 `DebugPanelImpl` 函数体与顶部 import。完整替换后的 `apps/controlplane/src/web/components/debug/debug-panel.tsx`：

```tsx
import { useDebugStore } from '../../stores/debug-store.js'
import { DebugToolbar } from './debug-toolbar.js'
import { EventListTab } from './event-list-tab.js'
import { NodeStatusTab } from './node-status-tab.js'
import { useDebugWindow } from './hooks/use-debug-window.js'
import { useEventPolling } from './hooks/use-event-polling.js'

const DEBUG_ENABLED = import.meta.env.VITE_ENABLE_DEBUG === 'true'

/**
 * 真正的实现。保持 named export 供测试文件直接渲染（绕开 DEBUG_ENABLED wrapper）。
 * 生产代码只通过下面的 `DebugPanel` wrapper 引用，未引用的情况下 rollup 会 tree-shake 掉整棵。
 */
export function DebugPanelImpl(): JSX.Element | null {
  const open = useDebugStore((s) => s.panelOpen)
  const tab = useDebugStore((s) => s.tab)
  const { style } = useDebugWindow({ x: 100, y: 100, width: 800, height: 500 })
  // useEventPolling 在 hook 内部按 (panelOpen && tab === 'events' && mode === 'realtime' && !paused) 启停
  useEventPolling()
  if (!open) return null
  return (
    <div
      data-testid="debug-panel-content"
      style={{
        ...style,
        background: '#1a1a1a',
        color: '#eee',
        border: '1px solid #333',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <DebugToolbar />
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'events' ? <EventListTab /> : <NodeStatusTab />}
      </div>
    </div>
  )
}

function EmptyComponent(): null {
  return null
}

export const DebugPanel = DEBUG_ENABLED ? DebugPanelImpl : EmptyComponent
```

**关键约束：** 外层 wrapper 必须保留，否则生产构建会把 `DebugToolbar` / `EventListTab` / `NodeStatusTab` / `useEventPolling` / `useDebugWindow` 的代码全部打进产物。

- [ ] **Step 5：再跑全部 debug 测试**

```bash
cd apps/controlplane && pnpm vitest run src/web/components/debug
```

- [ ] **Step 6：`pnpm check`**

```bash
pnpm check
```

- [ ] **Step 7：提交**

```bash
git add apps/controlplane/src/web/components/debug/
git commit -m "feat(controlplane): 新增 DebugToolbar 并装配 DebugPanel

Toolbar 管理 Tab 切换、模式切换、过滤器、时间范围、暂停/恢复/清空/熔断恢复；
Panel 根据 tab 渲染 EventListTab 或 NodeStatusTab，整体挂载 use-event-polling。"
```

---

## Task 10: 根路由挂载 DebugToggleButton + 端到端验收

**Files:**
- Modify: `apps/controlplane/src/web/routes/__root.tsx`
- Modify: `apps/controlplane/src/web/routes/__root.tsx`（含 DebugPanel 挂载）
- Create: `apps/controlplane/src/web/routes/__tests__/__root.test.tsx`

**范围：** 把 `DebugToggleButton` 和 `DebugPanel` 挂到 `__root.tsx`；做一次端到端手工验收（写入验收报告作为独立文件）。

- [ ] **Step 1：写挂载点测试**

创建 `apps/controlplane/src/web/routes/__tests__/__root.test.tsx`：

```tsx
import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { RootRouteComponent } from '../__root.js'

describe('RootRouteComponent', () => {
  // 默认测试环境 VITE_ENABLE_DEBUG 未设置 → DEBUG_ENABLED=false →
  // DebugToggleButton/DebugPanel 都是 EmptyComponent 不渲染任何内容。
  // "enabled" 分支由 Task 5/7/8/9 的 Impl 直接测试覆盖，本处只验证 wrapper 的接线。
  test('默认环境下挂载 Outlet 但不渲染 Debug 按钮', () => {
    const { container } = render(<RootRouteComponent />)
    expect(container.querySelector('button[aria-label="Debug"]')).toBeNull()
    expect(container.querySelector('[data-testid="debug-panel-content"]')).toBeNull()
  })
})
```

说明：测试无法在运行时翻转模块级 `DEBUG_ENABLED`（`vi.stubEnv` 改不了已经求值过的 `const`，
而 CLAUDE.md 禁止 `await import(...)`，也就不能 `vi.resetModules()` + 重新引入）。所以启用分支
用 Impl 直接测试覆盖（已在 Task 5/7/8/9 完成），关闭分支的正确性由 Task 10 Step 7 的 `grep dist/`
产物验证——这是 tree-shake 正确性的权威证明。

- [ ] **Step 2：运行测试验证失败**

```bash
cd apps/controlplane && pnpm vitest run src/web/routes/__tests__/__root.test.tsx
```

- [ ] **Step 3：修改 __root.tsx 增加挂载点**

替换 `apps/controlplane/src/web/routes/__root.tsx`：

```tsx
import { Outlet, createRootRoute } from '@tanstack/react-router'

import { DebugPanel } from '../components/debug/debug-panel.js'
import { DebugToggleButton } from '../components/debug/debug-toggle-button.js'

export const Route = createRootRoute({
  component: RootRouteComponent,
})

/**
 * 提供 SPA 根布局出口，同时挂载仅开发环境启用的 Debug 面板。
 * DebugToggleButton 与 DebugPanel 内部都按 VITE_ENABLE_DEBUG === 'true' 做严格判断。
 */
export function RootRouteComponent() {
  return (
    <>
      <Outlet />
      <DebugToggleButton />
      <DebugPanel />
    </>
  )
}
```

- [ ] **Step 4：再跑测试并通过**

```bash
cd apps/controlplane && pnpm vitest run src/web/routes/__tests__/__root.test.tsx
```

- [ ] **Step 5：全量 controlplane 测试**

```bash
cd apps/controlplane && pnpm vitest run
```

- [ ] **Step 6：`pnpm check`**

```bash
pnpm check
```

- [ ] **Step 7：生产构建产物验证（tree-shake）**

使用 `if / else` 结构保证 grep 命中时脚本以非零退出码失败（`grep ... || echo PASS` 是反模式：命中时 grep 仍 exit 0，脚本不会打印 PASS 也不会 fail，CI 静默放行）。

```bash
cd apps/controlplane && VITE_ENABLE_DEBUG=false pnpm build
if grep -rEq "DebugPanel|DebugToggleButton|DebugToolbar|EventListTab|NodeStatusTab|debug-store|debug-api|/api/debug/events|/api/debug/nodes" dist/web/; then
  echo "FAIL: 生产产物包含 debug 关键字"
  grep -rnE "DebugPanel|DebugToggleButton|DebugToolbar|EventListTab|NodeStatusTab|debug-store|debug-api|/api/debug/events|/api/debug/nodes" dist/web/ | head -n 20
  exit 1
else
  echo "PASS: 生产产物不含 debug 关键字"
fi
```

期望输出：`PASS: 生产产物不含 debug 关键字`。
若产物未被 tree-shake 干净：
1. 确认所有判断均为字面量 `import.meta.env.VITE_ENABLE_DEBUG === 'true'`（不允许 `VITE_ENABLE_DEBUG ? ... : ...` 这种 truthy 判断）。
2. 确认 `debug-panel.tsx` / `debug-toggle-button.tsx` 的外层 wrapper 写成 `DEBUG_ENABLED ? XxxImpl : EmptyComponent`，不是组件内 early return。
3. 确认 `__root.tsx` 通过 `DebugPanel` / `DebugToggleButton` wrapper 挂载，不是直接挂 Impl。
4. 若 `apps/controlplane/package.json` 未显式声明 `"sideEffects": false`，rollup 会保守地认为所有 import 都有副作用而阻止 tree-shake。检查并按需添加该字段（若项目已有明确用途则不要盲目改）。

- [ ] **Step 8：后端 404 验证（不再依赖手工步骤）**

此验证已由 Task 3 Step 1 的集成测试 `"未设置 TIANJI_DEBUG 时 /api/debug/* 返回 404"` 完全覆盖。
本步骤只做双保险：运行一次该集成测试，确认 spec §6.4 的验收仍通过。

```bash
cd apps/controlplane && pnpm vitest run src/routes/__tests__/debug-mount.test.ts
```

期望：两个 test 全绿。

- [ ] **Step 9：提交**

```bash
git add apps/controlplane/src/web/routes/__root.tsx apps/controlplane/src/web/routes/__tests__/__root.test.tsx
git commit -m "feat(controlplane): 在根路由挂载 DebugToggleButton 与 DebugPanel

严格按 VITE_ENABLE_DEBUG === 'true' 判断；生产构建产物中不会包含 debug 代码。"
```

---

## 自检清单（Plan 完成后自动做）

- **Spec 覆盖**
  - §3.1 条件挂载 → Task 3
  - §3.2 `/api/debug/events` → Task 1
  - §3.3 `/api/debug/nodes` → Task 2
  - §3.4 文件组织 → Task 1/2
  - §4.1-4.2 组件结构与职责 → Task 5/7/8/9
  - §4.3 debug-store → Task 4
  - §4.4 轮询与分页策略 → Task 6/7/9
  - §4.5 Hook 与文件组织 → Task 5/6/7
  - §5.1 前端环境隔离 → Task 5/10
  - §5.2 后端环境隔离 → Task 3
  - §6.1 后端单元测试 → Task 1/2
  - §6.3 前端组件测试 → Task 4-9
  - §6.4 环境隔离验收 → Task 10
  - §6.5 端到端手工清单 → Task 10
- **Placeholder**：所有 step 有具体代码或命令
- **命名一致性**：`DebugEvent`、`DebugNodeDto`、`fetchDebugEvents`、`fetchDebugNodes`、`useDebugStore`、`prependEvents`、`appendEvents`、`useEventPolling`、`useHistoryPagination`、`DebugToggleButton`、`DebugPanel`、`DebugToolbar`、`EventListTab`、`NodeStatusTab`、`EventDetailDrawer` 全文统一
