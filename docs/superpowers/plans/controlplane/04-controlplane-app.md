# Control Plane Web 应用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `apps/controlplane` Web 应用，实现 Node 注册/认证、心跳在线状态、长轮询指令下发、NDJSON 事件接收、Task 状态机、Web UI REST API 和 SSE 实时推送。

**Architecture:** 基于 Hono 框架的 Node.js HTTP 服务，使用 SQLite (better-sqlite3) + WAL 模式持久化。分为 node 端点（`/api/nodes/*`、`/api/tasks/:taskId/events`）和 UI 端点（`/api/ui/*`）。通过 Turbo 集成到 monorepo 构建链。

**Tech Stack:** TypeScript, Hono, better-sqlite3, Vitest, Node.js 20+

**设计文档:** `docs/superpowers/specs/2026-04-03-v3-distributed-node-controlplane-design.md` 第 3.2、4、8、9 节

**前置依赖:** `01-shared-protocol` 完成

---

### Task 1: 项目脚手架

**Files:**
- Create: `apps/controlplane/package.json`
- Create: `apps/controlplane/tsconfig.json`
- Create: `apps/controlplane/tsconfig.build.json`
- Create: `apps/controlplane/src/index.ts`

- [ ] **Step 1: 创建 package.json**

创建 `apps/controlplane/package.json`：

```json
{
  "name": "@tianji/controlplane",
  "version": "0.0.0",
  "description": "Control plane web application for tianji-ai distributed nodes",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc --project tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node dist/index.js",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@tianji/shared": "workspace:*",
    "@tianji/observer": "workspace:*",
    "hono": "^4.7.0",
    "@hono/node-server": "^1.14.0",
    "better-sqlite3": "^11.8.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/better-sqlite3": "^7.6.0"
  },
  "files": ["dist", "src"],
  "license": "MIT"
}
```

- [ ] **Step 2: 创建 tsconfig.json**

创建 `apps/controlplane/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: 创建 tsconfig.build.json**

创建 `apps/controlplane/tsconfig.build.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "exclude": ["src/**/__tests__/**", "src/**/*.test.ts"]
}
```

- [ ] **Step 4: 创建 src/index.ts 入口**

创建 `apps/controlplane/src/index.ts`：

```typescript
/**
 * @tianji/controlplane — Control Plane Web Application
 *
 * 统一管理所有设备上的 node，提供 Web UI 入口查看 agent 状态、下发任务、查阅日志。
 */

export { createApp } from './app.js'
```

- [ ] **Step 5: 创建 src/app.ts — Hono 应用工厂**

创建 `apps/controlplane/src/app.ts`：

```typescript
import { Hono } from 'hono'

export function createApp(): Hono {
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))

  return app
}
```

- [ ] **Step 6: 安装依赖**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm install`

- [ ] **Step 7: 运行 pnpm check 验证 monorepo 集成**

Run: `pnpm check`
Expected: 无错误（新包被正确识别）

- [ ] **Step 8: 提交**

```bash
git add apps/controlplane/
git commit -m "feat(controlplane): scaffold project with Hono, better-sqlite3, TypeScript"
```

---

### Task 2: 框架能力验证（长轮询 + NDJSON + SSE + SQLite）

**Files:**
- Create: `apps/controlplane/src/__tests__/capability-validation.test.ts`

- [ ] **Step 1: 编写能力验证测试**

```typescript
import { describe, expect, it, afterAll } from 'vitest'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import Database from 'better-sqlite3'
import { stream as honoStream, streamSSE } from 'hono/streaming'

describe('Framework Capability Validation', () => {
  describe('1. Long Polling: hold HTTP request for timeout', () => {
    it('should hold request and return after timeout', async () => {
      const app = new Hono()
      app.get('/poll', async (c) => {
        const timeout = Number(c.req.query('timeout') ?? 500)
        await new Promise((resolve) => setTimeout(resolve, timeout))
        return c.body(null, 204)
      })

      const server = serve({ fetch: app.fetch, port: 0 })
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0

      const start = Date.now()
      const resp = await fetch(`http://localhost:${port}/poll?timeout=200`)
      const elapsed = Date.now() - start

      expect(resp.status).toBe(204)
      expect(elapsed).toBeGreaterThanOrEqual(180)
      server.close()
    })
  })

  describe('2. SSE: support Last-Event-ID reconnect', () => {
    it('should stream SSE events and support last-event-id', async () => {
      const app = new Hono()
      app.get('/sse', (c) => {
        const lastId = Number(c.req.header('Last-Event-ID') ?? '0')
        return streamSSE(c, async (stream) => {
          for (let i = lastId + 1; i <= lastId + 3; i++) {
            await stream.writeSSE({
              event: 'test',
              data: JSON.stringify({ seq: i }),
              id: String(i),
            })
          }
        })
      })

      const server = serve({ fetch: app.fetch, port: 0 })
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0

      const resp = await fetch(`http://localhost:${port}/sse`, {
        headers: { 'Last-Event-ID': '5' },
      })
      const text = await resp.text()

      expect(text).toContain('id:6')
      expect(text).toContain('id:7')
      expect(text).toContain('id:8')
      server.close()
    })
  })

  describe('3. SQLite WAL: high-frequency writes do not block reads', () => {
    it('should handle concurrent reads and writes', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)')

      const insert = db.prepare('INSERT INTO test (value) VALUES (?)')
      const count = db.prepare('SELECT COUNT(*) as cnt FROM test')

      // 高频写入
      const writeMany = db.transaction(() => {
        for (let i = 0; i < 1000; i++) {
          insert.run(`value-${i}`)
        }
      })
      writeMany()

      // 读取不阻塞
      const result = count.get() as { cnt: number }
      expect(result.cnt).toBe(1000)

      db.close()
    })
  })

  describe('4. NDJSON: receive chunked POST body', () => {
    it('should receive NDJSON lines from chunked POST', async () => {
      const received: string[] = []
      const app = new Hono()
      app.post('/ndjson', async (c) => {
        const text = await c.req.text()
        const lines = text.split('\n').filter((l) => l.trim().length > 0)
        received.push(...lines)
        return c.json({ count: lines.length })
      })

      const server = serve({ fetch: app.fetch, port: 0 })
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0

      const body = '{"seq":1}\n{"seq":2}\n{"seq":3}\n'
      const resp = await fetch(`http://localhost:${port}/ndjson`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-ndjson' },
        body,
      })

      const data = await resp.json() as { count: number }
      expect(data.count).toBe(3)
      expect(received).toHaveLength(3)
      server.close()
    })
  })
})
```

- [ ] **Step 2: 运行能力验证测试**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose capability-validation`
Expected: 4/4 ALL PASS

若任一测试失败，需在此阶段确认替代方案，不继续后续 Task。

- [ ] **Step 3: 提交**

```bash
git add apps/controlplane/src/__tests__/capability-validation.test.ts
git commit -m "test(controlplane): validate framework capabilities — long poll, SSE, NDJSON, SQLite WAL"
```

---

### Task 3: SQLite 数据库 Schema 与初始化

**Files:**
- Create: `apps/controlplane/src/db/schema.ts`
- Create: `apps/controlplane/src/db/database.ts`
- Create: `apps/controlplane/src/db/__tests__/database.test.ts`
- Create: `apps/controlplane/src/db/index.ts`

- [ ] **Step 1: 编写 database.test.ts**

```typescript
import { describe, expect, it, afterEach } from 'vitest'
import { createDatabase, type ControlPlaneDb } from '../database.js'

describe('ControlPlaneDb', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

  it('should create all tables on init', () => {
    db = createDatabase(':memory:')
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]

    const tableNames = tables.map((t) => t.name)
    expect(tableNames).toContain('enrollment_tokens')
    expect(tableNames).toContain('nodes')
    expect(tableNames).toContain('agents')
    expect(tableNames).toContain('commands')
    expect(tableNames).toContain('tasks')
    expect(tableNames).toContain('sessions')
    expect(tableNames).toContain('task_sessions')
    expect(tableNames).toContain('task_events')
  })

  it('should enable WAL mode', () => {
    db = createDatabase(':memory:')
    const result = db.raw.pragma('journal_mode') as { journal_mode: string }[]
    expect(result[0]!.journal_mode).toBe('wal')
  })

  it('should enforce foreign keys', () => {
    db = createDatabase(':memory:')
    const result = db.raw.pragma('foreign_keys') as { foreign_keys: number }[]
    expect(result[0]!.foreign_keys).toBe(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose database`
Expected: FAIL

- [ ] **Step 3: 创建 schema.ts**

创建 `apps/controlplane/src/db/schema.ts`：

```typescript
/**
 * SQLite schema definitions for controlplane.
 *
 * 所有时间字段为 unix 毫秒（INTEGER）。
 * 设计文档：第 9 节。
 *
 * @module db/schema
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS enrollment_tokens (
  token       TEXT    PRIMARY KEY,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  node_id                TEXT    PRIMARY KEY,
  hostname               TEXT    NOT NULL,
  platform               TEXT    NOT NULL,
  version                TEXT    NOT NULL,
  status                 TEXT    NOT NULL DEFAULT 'offline'
                                 CHECK(status IN ('online', 'offline')),
  execution_state        TEXT    NOT NULL DEFAULT 'idle'
                                 CHECK(execution_state IN ('idle', 'busy')),
  access_token_hash      TEXT    NOT NULL,
  access_token_expires_at INTEGER NOT NULL,
  enrollment_token       TEXT    NOT NULL REFERENCES enrollment_tokens(token),
  last_heartbeat_at      INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  node_id    TEXT    NOT NULL REFERENCES nodes(node_id),
  agent_id   TEXT    NOT NULL,
  type       TEXT    NOT NULL CHECK(type IN ('native', 'third-party')),
  name       TEXT    NOT NULL,
  version    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, agent_id)
);

CREATE TABLE IF NOT EXISTS commands (
  command_id   TEXT    PRIMARY KEY,
  node_id      TEXT    NOT NULL REFERENCES nodes(node_id),
  type         TEXT    NOT NULL,
  payload      TEXT    NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'pending'
                       CHECK(state IN ('pending', 'leased', 'running',
                                       'completed', 'failed', 'observation_lost')),
  leased_at    INTEGER,
  completed_at INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commands_node_state ON commands(node_id, state);

CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT    PRIMARY KEY,
  command_id     TEXT    NOT NULL REFERENCES commands(command_id),
  node_id        TEXT    NOT NULL REFERENCES nodes(node_id),
  agent_id       TEXT    NOT NULL,
  goal           TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending'
                         CHECK(status IN ('pending', 'running', 'waiting',
                                          'completed', 'failed', 'cancelled', 'observation_lost')),
  latest_run_id  TEXT,
  failure_reason TEXT,
  summary        TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_node ON tasks(node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS sessions (
  session_id     TEXT    PRIMARY KEY,
  node_id        TEXT    NOT NULL REFERENCES nodes(node_id),
  agent_id       TEXT    NOT NULL,
  title          TEXT,
  created_by     TEXT    NOT NULL CHECK(created_by IN ('user', 'task')),
  last_run_id    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_node ON sessions(node_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(node_id, agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_sessions (
  task_id        TEXT    NOT NULL REFERENCES tasks(task_id),
  session_id     TEXT    NOT NULL REFERENCES sessions(session_id),
  attached_at    INTEGER NOT NULL,
  attached_by    TEXT    NOT NULL CHECK(attached_by IN ('user', 'agent')),
  PRIMARY KEY (task_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_task_sessions_session ON task_sessions(session_id, attached_at DESC);

CREATE TABLE IF NOT EXISTS task_events (
  task_id     TEXT    NOT NULL REFERENCES tasks(task_id),
  sequence    INTEGER NOT NULL,
  kind        TEXT    NOT NULL CHECK(kind IN ('lifecycle', 'agent')),
  payload     TEXT    NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, sequence)
);
`
```

- [ ] **Step 4: 创建 database.ts**

创建 `apps/controlplane/src/db/database.ts`：

```typescript
/**
 * Database initialization and access.
 *
 * @module db/database
 */

import Database from 'better-sqlite3'
import { SCHEMA_SQL } from './schema.js'

export interface ControlPlaneDb {
  readonly raw: Database.Database
  close(): void
}

/**
 * 创建并初始化 controlplane 数据库。
 *
 * @param path - 数据库文件路径（':memory:' 用于测试）
 */
export function createDatabase(path: string): ControlPlaneDb {
  const db = new Database(path)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  db.exec(SCHEMA_SQL)

  return {
    raw: db,
    close() {
      db.close()
    },
  }
}
```

- [ ] **Step 5: 创建 db/index.ts**

创建 `apps/controlplane/src/db/index.ts`：

```typescript
export { createDatabase, type ControlPlaneDb } from './database.js'
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose database`
Expected: ALL PASS

- [ ] **Step 7: 提交**

```bash
git add apps/controlplane/src/db/
git commit -m "feat(controlplane): implement SQLite schema and database initialization"
```

---

### Task 4: Node 注册与认证 API

**Files:**
- Create: `apps/controlplane/src/routes/node-register.ts`
- Create: `apps/controlplane/src/services/auth.ts`
- Create: `apps/controlplane/src/services/__tests__/auth.test.ts`
- Create: `apps/controlplane/src/routes/__tests__/node-register.test.ts`

- [ ] **Step 1: 编写 auth.test.ts**

```typescript
import { describe, expect, it } from 'vitest'
import { hashToken, generateAccessToken, verifyAccessToken } from '../auth.js'

describe('auth service', () => {
  it('should hash token deterministically', () => {
    const hash1 = hashToken('test-token')
    const hash2 = hashToken('test-token')
    expect(hash1).toBe(hash2)
  })

  it('should produce different hashes for different tokens', () => {
    const hash1 = hashToken('token-a')
    const hash2 = hashToken('token-b')
    expect(hash1).not.toBe(hash2)
  })

  it('should generate a non-empty access token', () => {
    const token = generateAccessToken()
    expect(token.length).toBeGreaterThan(20)
  })

  it('should verify a valid token against its hash', () => {
    const token = generateAccessToken()
    const hash = hashToken(token)
    expect(verifyAccessToken(token, hash)).toBe(true)
  })

  it('should reject an invalid token', () => {
    const hash = hashToken('real-token')
    expect(verifyAccessToken('wrong-token', hash)).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose auth`
Expected: FAIL

- [ ] **Step 3: 实现 auth.ts**

创建 `apps/controlplane/src/services/auth.ts`：

```typescript
/**
 * Authentication utilities for controlplane.
 *
 * @module services/auth
 */

import { createHash, randomBytes } from 'node:crypto'

/** SHA-256 hash token for storage */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 生成随机 access token（48 bytes → 64 chars base64url） */
export function generateAccessToken(): string {
  return randomBytes(48).toString('base64url')
}

/** 验证 access token 是否匹配 hash */
export function verifyAccessToken(token: string, hash: string): boolean {
  return hashToken(token) === hash
}

/** 90 天有效期（毫秒） */
export const ACCESS_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose auth`
Expected: ALL PASS

- [ ] **Step 5: 编写 node-register.test.ts**

```typescript
import { describe, expect, it, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createDatabase, type ControlPlaneDb } from '../../db/index.js'
import { createNodeRegisterRoute } from '../node-register.js'

describe('POST /api/nodes/register', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    // 预置 enrollment token
    db.raw.prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)').run(
      'valid-token',
      Date.now(),
    )

    const app = new Hono()
    app.route('/', createNodeRegisterRoute(db))
    return app
  }

  it('should register a new node and return access token', async () => {
    const app = setup()
    const resp = await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-001',
        enrollmentToken: 'valid-token',
        hostname: 'dev-machine',
        platform: 'linux',
        version: '3.0.0',
        agentList: [{ agentId: 'default', type: 'native', name: 'default', version: '3.0.0' }],
      }),
    })

    expect(resp.status).toBe(200)
    const data = await resp.json() as { accessToken: string; expiresAt: number }
    expect(data.accessToken).toBeDefined()
    expect(data.expiresAt).toBeGreaterThan(Date.now())
  })

  it('should reject invalid enrollment token', async () => {
    const app = setup()
    const resp = await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-002',
        enrollmentToken: 'invalid-token',
        hostname: 'dev-machine',
        platform: 'linux',
        version: '3.0.0',
        agentList: [],
      }),
    })

    expect(resp.status).toBe(403)
  })

  it('should re-register existing node with new access token', async () => {
    const app = setup()

    // 首次注册
    await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-001',
        enrollmentToken: 'valid-token',
        hostname: 'dev-1',
        platform: 'linux',
        version: '3.0.0',
        agentList: [],
      }),
    })

    // 重新注册
    const resp = await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-001',
        enrollmentToken: 'valid-token',
        hostname: 'dev-1-updated',
        platform: 'linux',
        version: '3.1.0',
        agentList: [],
      }),
    })

    expect(resp.status).toBe(200)

    // 验证 hostname 已更新
    const node = db.raw.prepare('SELECT hostname, version FROM nodes WHERE node_id = ?').get('node-001') as any
    expect(node.hostname).toBe('dev-1-updated')
    expect(node.version).toBe('3.1.0')
  })
})
```

- [ ] **Step 6: 实现 node-register.ts**

创建 `apps/controlplane/src/routes/node-register.ts`：

```typescript
/**
 * Node registration endpoint.
 *
 * POST /api/nodes/register
 *
 * @module routes/node-register
 */

import { Hono } from 'hono'
import type { ControlPlaneDb } from '../db/index.js'
import { hashToken, generateAccessToken, ACCESS_TOKEN_TTL_MS } from '../services/auth.js'
import type { NodeRegisterRequest } from '@tianji/shared'

export function createNodeRegisterRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()

  app.post('/api/nodes/register', async (c) => {
    const body = (await c.req.json()) as NodeRegisterRequest

    // 验证 enrollmentToken
    const tokenRow = db.raw
      .prepare('SELECT token FROM enrollment_tokens WHERE token = ?')
      .get(body.enrollmentToken)

    if (!tokenRow) {
      return c.json({ error: 'Invalid enrollment token' }, 403)
    }

    const accessToken = generateAccessToken()
    const accessTokenHash = hashToken(accessToken)
    const now = Date.now()
    const expiresAt = now + ACCESS_TOKEN_TTL_MS

    const existingNode = db.raw
      .prepare('SELECT node_id FROM nodes WHERE node_id = ?')
      .get(body.nodeId)

    if (existingNode) {
      // Re-enroll: 更新 token 和元数据
      db.raw.prepare(`
        UPDATE nodes SET
          hostname = ?,
          platform = ?,
          version = ?,
          status = 'online',
          access_token_hash = ?,
          access_token_expires_at = ?,
          last_heartbeat_at = ?,
          updated_at = ?
        WHERE node_id = ?
      `).run(
        body.hostname, body.platform, body.version,
        accessTokenHash, expiresAt, now, now,
        body.nodeId,
      )
    } else {
      // 新注册
      db.raw.prepare(`
        INSERT INTO nodes (
          node_id, hostname, platform, version, status,
          execution_state, access_token_hash, access_token_expires_at,
          enrollment_token, last_heartbeat_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'online', 'idle', ?, ?, ?, ?, ?, ?)
      `).run(
        body.nodeId, body.hostname, body.platform, body.version,
        accessTokenHash, expiresAt,
        body.enrollmentToken, now, now, now,
      )
    }

    // 更新 agent 列表（整体覆盖）
    updateAgentList(db, body.nodeId, body.agentList, now)

    return c.json({ accessToken, expiresAt })
  })

  return app
}

/** 整体覆盖 agent 列表 */
export function updateAgentList(
  db: ControlPlaneDb,
  nodeId: string,
  agentList: readonly { agentId: string; type: string; name: string; version: string }[],
  now: number,
): void {
  db.raw.prepare('DELETE FROM agents WHERE node_id = ?').run(nodeId)
  const insert = db.raw.prepare(
    'INSERT INTO agents (node_id, agent_id, type, name, version, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  for (const agent of agentList) {
    insert.run(nodeId, agent.agentId, agent.type, agent.name, agent.version, now)
  }
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose node-register`
Expected: ALL PASS

- [ ] **Step 8: 提交**

```bash
git add apps/controlplane/src/services/auth.ts apps/controlplane/src/services/__tests__/auth.test.ts apps/controlplane/src/routes/node-register.ts apps/controlplane/src/routes/__tests__/node-register.test.ts
git commit -m "feat(controlplane): implement node registration with enrollment token auth"
```

---

### Task 5: 心跳端点与在线状态维护

**Files:**
- Create: `apps/controlplane/src/routes/node-heartbeat.ts`
- Create: `apps/controlplane/src/routes/__tests__/node-heartbeat.test.ts`
- Create: `apps/controlplane/src/middleware/auth.ts`

- [ ] **Step 1: 实现 auth 中间件**

创建 `apps/controlplane/src/middleware/auth.ts`：

```typescript
/**
 * Bearer token authentication middleware.
 *
 * @module middleware/auth
 */

import type { Context, Next } from 'hono'
import type { ControlPlaneDb } from '../db/index.js'
import { hashToken } from '../services/auth.js'

/**
 * 创建 Bearer token 认证中间件。
 * 验证 access token hash 匹配，且未过期。
 * 通过后将 nodeId 设置到 context variable。
 */
export function createAuthMiddleware(db: ControlPlaneDb) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing authorization' }, 401)
    }

    const token = authHeader.slice(7)
    const tokenHash = hashToken(token)
    const now = Date.now()

    const node = db.raw.prepare(`
      SELECT node_id FROM nodes
      WHERE access_token_hash = ? AND access_token_expires_at > ?
    `).get(tokenHash, now) as { node_id: string } | undefined

    if (!node) {
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    c.set('nodeId', node.node_id)
    await next()
  }
}
```

- [ ] **Step 2: 编写 node-heartbeat.test.ts**

```typescript
import { describe, expect, it, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createDatabase, type ControlPlaneDb } from '../../db/index.js'
import { createNodeHeartbeatRoute } from '../node-heartbeat.js'
import { createNodeRegisterRoute } from '../node-register.js'

describe('POST /api/nodes/:nodeId/heartbeat', () => {
  let db: ControlPlaneDb
  let accessToken: string

  afterEach(() => {
    db?.close()
  })

  async function setup() {
    db = createDatabase(':memory:')
    db.raw.prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)').run(
      'valid-token', Date.now(),
    )

    const app = new Hono()
    app.route('/', createNodeRegisterRoute(db))
    app.route('/', createNodeHeartbeatRoute(db))

    // 注册 node
    const resp = await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-001',
        enrollmentToken: 'valid-token',
        hostname: 'dev', platform: 'linux', version: '3.0.0',
        agentList: [{ agentId: 'default', type: 'native', name: 'default', version: '3.0.0' }],
      }),
    })
    const data = await resp.json() as { accessToken: string }
    accessToken = data.accessToken

    return app
  }

  it('should accept heartbeat and update last_heartbeat_at', async () => {
    const app = await setup()
    const resp = await app.request('/api/nodes/node-001/heartbeat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ executionState: 'idle' }),
    })

    expect(resp.status).toBe(204)

    const node = db.raw.prepare('SELECT last_heartbeat_at, execution_state FROM nodes WHERE node_id = ?')
      .get('node-001') as any
    expect(node.execution_state).toBe('idle')
    expect(node.last_heartbeat_at).toBeGreaterThan(0)
  })

  it('should update execution_state to busy', async () => {
    const app = await setup()
    await app.request('/api/nodes/node-001/heartbeat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ executionState: 'busy' }),
    })

    const node = db.raw.prepare('SELECT execution_state FROM nodes WHERE node_id = ?')
      .get('node-001') as any
    expect(node.execution_state).toBe('busy')
  })

  it('should reject without auth token', async () => {
    const app = await setup()
    const resp = await app.request('/api/nodes/node-001/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionState: 'idle' }),
    })

    expect(resp.status).toBe(401)
  })
})
```

- [ ] **Step 3: 实现 node-heartbeat.ts**

创建 `apps/controlplane/src/routes/node-heartbeat.ts`：

```typescript
/**
 * Node heartbeat endpoint.
 *
 * POST /api/nodes/:nodeId/heartbeat
 *
 * @module routes/node-heartbeat
 */

import { Hono } from 'hono'
import type { ControlPlaneDb } from '../db/index.js'
import { createAuthMiddleware } from '../middleware/auth.js'
import { updateAgentList } from './node-register.js'
import type { NodeHeartbeatRequest } from '@tianji/shared'

/** 心跳超时阈值（90s 无心跳标记 offline） */
export const HEARTBEAT_TIMEOUT_MS = 90_000

export function createNodeHeartbeatRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()
  const auth = createAuthMiddleware(db)

  app.post('/api/nodes/:nodeId/heartbeat', auth, async (c) => {
    const nodeId = c.req.param('nodeId')
    const authenticatedNodeId = c.get('nodeId') as string

    if (nodeId !== authenticatedNodeId) {
      return c.json({ error: 'Node ID mismatch' }, 403)
    }

    const body = (await c.req.json()) as NodeHeartbeatRequest
    const now = Date.now()

    db.raw.prepare(`
      UPDATE nodes SET
        status = 'online',
        execution_state = ?,
        last_heartbeat_at = ?,
        updated_at = ?
      WHERE node_id = ?
    `).run(body.executionState, now, now, nodeId)

    if (body.agentList) {
      updateAgentList(db, nodeId, body.agentList, now)
    }

    return c.body(null, 204)
  })

  return app
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose node-heartbeat`
Expected: ALL PASS

- [ ] **Step 5: 提交**

```bash
git add apps/controlplane/src/middleware/auth.ts apps/controlplane/src/routes/node-heartbeat.ts apps/controlplane/src/routes/__tests__/node-heartbeat.test.ts
git commit -m "feat(controlplane): implement heartbeat endpoint with auth middleware"
```

---

### Task 6: 长轮询指令下发端点

**Files:**
- Create: `apps/controlplane/src/routes/command-poll.ts`
- Create: `apps/controlplane/src/routes/__tests__/command-poll.test.ts`

- [ ] **Step 1: 编写 command-poll.test.ts**

```typescript
import { describe, expect, it, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createDatabase, type ControlPlaneDb } from '../../db/index.js'
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
    db.raw.prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)').run(
      'valid-token', Date.now(),
    )

    const app = new Hono()
    app.route('/', createNodeRegisterRoute(db))
    app.route('/', createCommandPollRoute(db))

    const resp = await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-001', enrollmentToken: 'valid-token',
        hostname: 'dev', platform: 'linux', version: '3.0.0', agentList: [],
      }),
    })
    accessToken = ((await resp.json()) as { accessToken: string }).accessToken
    return app
  }

  it('should return 204 when no pending commands', async () => {
    const app = await setup()
    const resp = await app.request('/api/nodes/node-001/commands/poll?timeout=100', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    expect(resp.status).toBe(204)
  })

  it('should return pending command and mark as leased', async () => {
    const app = await setup()

    // 插入 pending command
    const now = Date.now()
    db.raw.prepare(`
      INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
      VALUES ('task-1', 'cmd-1', 'node-001', 'default', 'test goal', 'pending', ?, ?)
    `).run(now, now)

    db.raw.prepare(`
      INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
      VALUES ('cmd-1', 'node-001', 'task.run', ?, 'pending', ?)
    `).run(JSON.stringify({ taskId: 'task-1', agentId: 'default', goal: 'test goal' }), now)

    const resp = await app.request('/api/nodes/node-001/commands/poll?timeout=100', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    expect(resp.status).toBe(200)
    const data = await resp.json() as { commandId: string; type: string }
    expect(data.commandId).toBe('cmd-1')
    expect(data.type).toBe('task.run')

    // 验证已标记为 leased
    const cmd = db.raw.prepare('SELECT state FROM commands WHERE command_id = ?').get('cmd-1') as any
    expect(cmd.state).toBe('leased')
  })

  it('should not return command when node execution_state is busy', async () => {
    const app = await setup()

    // 设置 node 为 busy
    db.raw.prepare('UPDATE nodes SET execution_state = ? WHERE node_id = ?').run('busy', 'node-001')

    // 插入 pending command
    const now = Date.now()
    db.raw.prepare(`
      INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
      VALUES ('task-1', 'cmd-1', 'node-001', 'default', 'test', 'pending', ?, ?)
    `).run(now, now)
    db.raw.prepare(`
      INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
      VALUES ('cmd-1', 'node-001', 'task.run', '{}', 'pending', ?)
    `).run(now)

    const resp = await app.request('/api/nodes/node-001/commands/poll?timeout=100', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    expect(resp.status).toBe(204)
  })
})
```

- [ ] **Step 2: 实现 command-poll.ts**

创建 `apps/controlplane/src/routes/command-poll.ts`：

```typescript
/**
 * Long-poll command dispatch endpoint.
 *
 * GET /api/nodes/:nodeId/commands/poll?timeout=30000
 *
 * @module routes/command-poll
 */

import { Hono } from 'hono'
import type { ControlPlaneDb } from '../db/index.js'
import { createAuthMiddleware } from '../middleware/auth.js'

export function createCommandPollRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()
  const auth = createAuthMiddleware(db)

  app.get('/api/nodes/:nodeId/commands/poll', auth, async (c) => {
    const nodeId = c.req.param('nodeId')
    const authenticatedNodeId = c.get('nodeId') as string
    if (nodeId !== authenticatedNodeId) {
      return c.json({ error: 'Node ID mismatch' }, 403)
    }

    const timeout = Math.min(Number(c.req.query('timeout') ?? 30000), 60000)

    // 检查 node 执行状态
    const node = db.raw.prepare('SELECT execution_state FROM nodes WHERE node_id = ?')
      .get(nodeId) as { execution_state: string } | undefined

    if (node?.execution_state === 'busy') {
      return c.body(null, 204)
    }

    // 尝试获取 pending command
    const command = tryLeasePendingCommand(db, nodeId)
    if (command) {
      return c.json(command)
    }

    // 无 pending command，等待直到超时
    const deadline = Date.now() + timeout
    const pollInterval = 1000

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval))
      const cmd = tryLeasePendingCommand(db, nodeId)
      if (cmd) {
        return c.json(cmd)
      }
    }

    return c.body(null, 204)
  })

  return app
}

function tryLeasePendingCommand(
  db: ControlPlaneDb,
  nodeId: string,
): { commandId: string; type: string; payload: unknown } | null {
  const row = db.raw.prepare(`
    SELECT command_id, type, payload FROM commands
    WHERE node_id = ? AND state = 'pending'
    ORDER BY created_at ASC
    LIMIT 1
  `).get(nodeId) as { command_id: string; type: string; payload: string } | undefined

  if (!row) return null

  const now = Date.now()

  // 原子性 lease: UPDATE ... WHERE state = 'pending'
  const result = db.raw.prepare(`
    UPDATE commands SET state = 'leased', leased_at = ?
    WHERE command_id = ? AND state = 'pending'
  `).run(now, row.command_id)

  if (result.changes === 0) return null

  // 同步更新 task 状态
  db.raw.prepare(`
    UPDATE tasks SET status = 'running', updated_at = ?
    WHERE command_id = ?
  `).run(now, row.command_id)

  return {
    commandId: row.command_id,
    type: row.type,
    payload: JSON.parse(row.payload),
  }
}
```

- [ ] **Step 3: 运行测试确认通过**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose command-poll`
Expected: ALL PASS

- [ ] **Step 4: 提交**

```bash
git add apps/controlplane/src/routes/command-poll.ts apps/controlplane/src/routes/__tests__/command-poll.test.ts
git commit -m "feat(controlplane): implement long-poll command dispatch with busy-node guard"
```

---

### Task 7: NDJSON 事件接收与持久化

**Files:**
- Create: `apps/controlplane/src/routes/task-events.ts`
- Create: `apps/controlplane/src/services/event-store.ts`
- Create: `apps/controlplane/src/services/__tests__/event-store.test.ts`
- Create: `apps/controlplane/src/routes/__tests__/task-events.test.ts`

- [ ] **Step 1: 编写 event-store.test.ts**

```typescript
import { describe, expect, it, afterEach } from 'vitest'
import { createDatabase, type ControlPlaneDb } from '../../db/index.js'
import { EventStore } from '../event-store.js'

describe('EventStore', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    // 需要 task 存在才能插入事件（外键约束）
    db.raw.prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)').run('t', Date.now())
    db.raw.prepare(`
      INSERT INTO nodes (node_id, hostname, platform, version, access_token_hash, access_token_expires_at, enrollment_token, created_at, updated_at)
      VALUES ('n', 'h', 'linux', '1', 'hash', 999999999999999, 't', 0, 0)
    `).run()
    db.raw.prepare(`
      INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
      VALUES ('cmd-1', 'n', 'task.run', '{}', 'leased', 0)
    `).run()
    db.raw.prepare(`
      INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
      VALUES ('task-1', 'cmd-1', 'n', 'a', 'g', 'running', 0, 0)
    `).run()

    return new EventStore(db)
  }

  it('should insert events', () => {
    const store = setup()
    store.insertEvent('task-1', 1, 'lifecycle', '{"type":"task.started"}')
    store.insertEvent('task-1', 2, 'agent', '{"type":"message.delta"}')

    const events = store.getEvents('task-1', 0, 100)
    expect(events).toHaveLength(2)
  })

  it('should deduplicate by taskId + sequence', () => {
    const store = setup()
    store.insertEvent('task-1', 1, 'lifecycle', '{"type":"task.started"}')
    store.insertEvent('task-1', 1, 'lifecycle', '{"type":"task.started"}') // duplicate

    const events = store.getEvents('task-1', 0, 100)
    expect(events).toHaveLength(1)
  })

  it('should return events after a given sequence', () => {
    const store = setup()
    store.insertEvent('task-1', 1, 'lifecycle', '{}')
    store.insertEvent('task-1', 2, 'agent', '{}')
    store.insertEvent('task-1', 3, 'agent', '{}')

    const events = store.getEvents('task-1', 1, 100)
    expect(events).toHaveLength(2)
    expect(events[0]!.sequence).toBe(2)
  })
})
```

- [ ] **Step 2: 实现 event-store.ts**

创建 `apps/controlplane/src/services/event-store.ts`：

```typescript
/**
 * Task event storage and retrieval.
 *
 * @module services/event-store
 */

import type { ControlPlaneDb } from '../db/index.js'

export interface StoredTaskEvent {
  taskId: string
  sequence: number
  kind: string
  payload: string
  receivedAt: number
}

export class EventStore {
  readonly #db: ControlPlaneDb

  constructor(db: ControlPlaneDb) {
    this.#db = db
  }

  /** INSERT OR IGNORE 实现去重 */
  insertEvent(taskId: string, sequence: number, kind: string, payload: string): void {
    const now = Date.now()
    this.#db.raw.prepare(`
      INSERT OR IGNORE INTO task_events (task_id, sequence, kind, payload, received_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, sequence, kind, payload, now)
  }

  /** 获取 sequence > afterSequence 的事件 */
  getEvents(taskId: string, afterSequence: number, limit: number): StoredTaskEvent[] {
    return this.#db.raw.prepare(`
      SELECT task_id AS taskId, sequence, kind, payload, received_at AS receivedAt
      FROM task_events
      WHERE task_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(taskId, afterSequence, limit) as StoredTaskEvent[]
  }
}
```

- [ ] **Step 3: 运行 event-store 测试**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose event-store`
Expected: ALL PASS

- [ ] **Step 4: 编写 task-events.test.ts**

```typescript
import { describe, expect, it, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createDatabase, type ControlPlaneDb } from '../../db/index.js'
import { createTaskEventsRoute } from '../task-events.js'
import { hashToken, generateAccessToken } from '../../services/auth.js'

describe('POST /api/tasks/:taskId/events', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    const token = generateAccessToken()
    const hash = hashToken(token)
    const now = Date.now()

    db.raw.prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)').run('et', now)
    db.raw.prepare(`
      INSERT INTO nodes (node_id, hostname, platform, version, access_token_hash, access_token_expires_at, enrollment_token, created_at, updated_at)
      VALUES ('n1', 'h', 'linux', '1', ?, ?, 'et', ?, ?)
    `).run(hash, now + 999999, now, now)
    db.raw.prepare(`
      INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
      VALUES ('cmd-1', 'n1', 'task.run', '{}', 'leased', ?)
    `).run(now)
    db.raw.prepare(`
      INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
      VALUES ('task-1', 'cmd-1', 'n1', 'default', 'test', 'running', ?, ?)
    `).run(now, now)

    const app = new Hono()
    app.route('/', createTaskEventsRoute(db))
    return { app, token }
  }

  it('should accept NDJSON body and persist events', async () => {
    const { app, token } = setup()
    const body = [
      JSON.stringify({ kind: 'lifecycle', taskId: 'task-1', type: 'task.started', sequence: 1, timestamp: Date.now() }),
      JSON.stringify({ kind: 'agent', taskId: 'task-1', sequence: 2, sessionId: 's1', runId: 'r1', event: { type: 'message.delta' } }),
    ].join('\n') + '\n'

    const resp = await app.request('/api/tasks/task-1/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${token}`,
      },
      body,
    })

    expect(resp.status).toBe(200)

    const events = db.raw.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY sequence').all('task-1')
    expect(events).toHaveLength(2)
  })
})
```

- [ ] **Step 5: 实现 task-events.ts**

创建 `apps/controlplane/src/routes/task-events.ts`：

```typescript
/**
 * Task events ingestion endpoint (NDJSON).
 *
 * POST /api/tasks/:taskId/events
 *
 * @module routes/task-events
 */

import { Hono } from 'hono'
import type { ControlPlaneDb } from '../db/index.js'
import { createAuthMiddleware } from '../middleware/auth.js'
import { EventStore } from '../services/event-store.js'

export function createTaskEventsRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()
  const auth = createAuthMiddleware(db)
  const eventStore = new EventStore(db)

  app.post('/api/tasks/:taskId/events', auth, async (c) => {
    const taskId = c.req.param('taskId')
    const body = await c.req.text()
    const lines = body.split('\n').filter((line) => line.trim().length > 0)

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as {
          kind: string
          sequence: number
          taskId?: string
          type?: string
        }

        eventStore.insertEvent(taskId, event.sequence, event.kind, line)

        // 更新 task 状态（lifecycle 事件）
        if (event.kind === 'lifecycle' && event.type) {
          updateTaskFromLifecycle(db, taskId, event as any)
        }
      } catch {
        // 跳过不合法的行
      }
    }

    return c.json({ accepted: lines.length })
  })

  return app
}

function updateTaskFromLifecycle(
  db: ControlPlaneDb,
  taskId: string,
  event: { type: string; summary?: string; error?: string; sessionId?: string },
): void {
  const now = Date.now()

  switch (event.type) {
    case 'task.started':
      db.raw.prepare('UPDATE tasks SET status = ?, summary = ?, updated_at = ? WHERE task_id = ?')
        .run('running', event.summary ?? null, now, taskId)
      break
    case 'task.waiting':
      db.raw.prepare('UPDATE tasks SET status = ?, summary = ?, updated_at = ? WHERE task_id = ?')
        .run('waiting', event.summary ?? null, now, taskId)
      break
    case 'task.completed':
      db.raw.prepare('UPDATE tasks SET status = ?, summary = ?, updated_at = ? WHERE task_id = ?')
        .run('completed', event.summary ?? null, now, taskId)
      db.raw.prepare('UPDATE commands SET state = ?, completed_at = ? WHERE command_id = (SELECT command_id FROM tasks WHERE task_id = ?)')
        .run('completed', now, taskId)
      break
    case 'task.failed':
      db.raw.prepare('UPDATE tasks SET status = ?, failure_reason = ?, updated_at = ? WHERE task_id = ?')
        .run('failed', event.error ?? 'agent_error', now, taskId)
      db.raw.prepare('UPDATE commands SET state = ?, completed_at = ? WHERE command_id = (SELECT command_id FROM tasks WHERE task_id = ?)')
        .run('failed', now, taskId)
      break
    case 'task.cancelled':
      db.raw.prepare('UPDATE tasks SET status = ?, failure_reason = ?, updated_at = ? WHERE task_id = ?')
        .run('cancelled', 'cancelled_by_user', now, taskId)
      db.raw.prepare('UPDATE commands SET state = ?, completed_at = ? WHERE command_id = (SELECT command_id FROM tasks WHERE task_id = ?)')
        .run('failed', now, taskId)
      break
    case 'task.session.attached':
      if (event.sessionId) {
        db.raw.prepare(`
          INSERT OR IGNORE INTO task_sessions (task_id, session_id, attached_at, attached_by)
          VALUES (?, ?, ?, 'agent')
        `).run(taskId, event.sessionId, now)
      }
      break
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose task-events`
Expected: ALL PASS

- [ ] **Step 7: 提交**

```bash
git add apps/controlplane/src/services/event-store.ts apps/controlplane/src/services/__tests__/event-store.test.ts apps/controlplane/src/routes/task-events.ts apps/controlplane/src/routes/__tests__/task-events.test.ts
git commit -m "feat(controlplane): implement NDJSON event ingestion with dedup and task state sync"
```

---

### Task 8: Web UI REST API — 节点列表与任务 CRUD

**Files:**
- Create: `apps/controlplane/src/routes/ui-nodes.ts`
- Create: `apps/controlplane/src/routes/ui-tasks.ts`
- Create: `apps/controlplane/src/routes/__tests__/ui-tasks.test.ts`

- [ ] **Step 1: 实现 ui-nodes.ts**

创建 `apps/controlplane/src/routes/ui-nodes.ts`：

```typescript
/**
 * GET /api/ui/nodes — 节点列表
 *
 * @module routes/ui-nodes
 */

import { Hono } from 'hono'
import type { ControlPlaneDb } from '../db/index.js'
import { HEARTBEAT_TIMEOUT_MS } from './node-heartbeat.js'

export function createUiNodesRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()

  app.get('/api/ui/nodes', (c) => {
    const now = Date.now()
    const nodes = db.raw.prepare('SELECT * FROM nodes').all() as any[]

    const result = nodes.map((node) => {
      const status =
        node.last_heartbeat_at && now - node.last_heartbeat_at < HEARTBEAT_TIMEOUT_MS
          ? 'online'
          : 'offline'

      const agents = db.raw
        .prepare('SELECT agent_id, type, name, version FROM agents WHERE node_id = ?')
        .all(node.node_id)

      return {
        nodeId: node.node_id,
        hostname: node.hostname,
        platform: node.platform,
        version: node.version,
        status,
        executionState: node.execution_state,
        lastHeartbeatAt: node.last_heartbeat_at,
        agents: agents.map((a: any) => ({
          agentId: a.agent_id,
          type: a.type,
          name: a.name,
          version: a.version,
        })),
      }
    })

    return c.json(result)
  })

  return app
}
```

- [ ] **Step 2: 实现 ui-tasks.ts**

创建 `apps/controlplane/src/routes/ui-tasks.ts`：

```typescript
/**
 * Web UI task endpoints.
 *
 * POST   /api/ui/tasks     — 创建任务
 * GET    /api/ui/tasks      — 任务列表
 * GET    /api/ui/tasks/:id  — 任务详情
 *
 * @module routes/ui-tasks
 */

import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { ControlPlaneDb } from '../db/index.js'

export function createUiTasksRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()

  // 创建任务
  app.post('/api/ui/tasks', async (c) => {
    const body = (await c.req.json()) as {
      nodeId: string
      agentId: string
      goal: string
      sessionIds?: string[]
    }

    const now = Date.now()

    // 检查 node 是否 online
    const node = db.raw.prepare('SELECT status FROM nodes WHERE node_id = ?').get(body.nodeId) as any
    if (!node) return c.json({ error: 'Node not found' }, 404)
    if (node.status === 'offline') return c.json({ error: 'Node is offline' }, 409)

    // 校验 sessionIds 归属
    if (body.sessionIds) {
      for (const sid of body.sessionIds) {
        const session = db.raw.prepare('SELECT node_id FROM sessions WHERE session_id = ?').get(sid) as any
        if (!session || session.node_id !== body.nodeId) {
          return c.json({ error: `Session ${sid} does not belong to node ${body.nodeId}` }, 400)
        }
      }
    }

    const taskId = randomUUID()
    const commandId = randomUUID()
    const payload = JSON.stringify({
      taskId,
      agentId: body.agentId,
      goal: body.goal,
      sessionIds: body.sessionIds,
    })

    // 在事务中创建 task + command
    db.raw.prepare(`
      INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
      VALUES (?, ?, 'task.run', ?, 'pending', ?)
    `).run(commandId, body.nodeId, payload, now)

    db.raw.prepare(`
      INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(taskId, commandId, body.nodeId, body.agentId, body.goal, now, now)

    return c.json({ taskId, commandId, status: 'pending', createdAt: now }, 201)
  })

  // 任务列表
  app.get('/api/ui/tasks', (c) => {
    const nodeId = c.req.query('nodeId')
    const status = c.req.query('status')
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 100)
    const cursor = c.req.query('cursor')

    let sql = 'SELECT * FROM tasks WHERE 1=1'
    const params: unknown[] = []

    if (nodeId) { sql += ' AND node_id = ?'; params.push(nodeId) }
    if (status) { sql += ' AND status = ?'; params.push(status) }
    if (cursor) { sql += ' AND task_id > ?'; params.push(cursor) }

    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit + 1)

    const rows = db.raw.prepare(sql).all(...params) as any[]
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map(mapTaskRow)
    const nextCursor = hasMore ? items[items.length - 1]?.taskId ?? null : null

    return c.json({ items, nextCursor })
  })

  // 任务详情
  app.get('/api/ui/tasks/:taskId', (c) => {
    const taskId = c.req.param('taskId')
    const row = db.raw.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as any
    if (!row) return c.json({ error: 'Task not found' }, 404)

    const sessionIds = db.raw
      .prepare('SELECT session_id FROM task_sessions WHERE task_id = ?')
      .all(taskId)
      .map((r: any) => r.session_id)

    return c.json({ ...mapTaskRow(row), sessionIds })
  })

  return app
}

function mapTaskRow(row: any) {
  return {
    taskId: row.task_id,
    commandId: row.command_id,
    nodeId: row.node_id,
    agentId: row.agent_id,
    goal: row.goal,
    status: row.status,
    latestRunId: row.latest_run_id,
    failureReason: row.failure_reason,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
```

- [ ] **Step 3: 编写 ui-tasks.test.ts**

```typescript
import { describe, expect, it, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createDatabase, type ControlPlaneDb } from '../../db/index.js'
import { createUiTasksRoute } from '../ui-tasks.js'

describe('UI Tasks API', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    const now = Date.now()
    db.raw.prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)').run('t', now)
    db.raw.prepare(`
      INSERT INTO nodes (node_id, hostname, platform, version, status, access_token_hash, access_token_expires_at, enrollment_token, last_heartbeat_at, created_at, updated_at)
      VALUES ('n1', 'h', 'linux', '1', 'online', 'hash', 999999999999999, 't', ?, ?, ?)
    `).run(now, now, now)

    const app = new Hono()
    app.route('/', createUiTasksRoute(db))
    return app
  }

  it('POST /api/ui/tasks should create task and command', async () => {
    const app = setup()
    const resp = await app.request('/api/ui/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', agentId: 'default', goal: 'test' }),
    })

    expect(resp.status).toBe(201)
    const data = await resp.json() as any
    expect(data.taskId).toBeDefined()
    expect(data.status).toBe('pending')
  })

  it('POST /api/ui/tasks should reject offline node', async () => {
    const app = setup()
    db.raw.prepare('UPDATE nodes SET status = ? WHERE node_id = ?').run('offline', 'n1')

    const resp = await app.request('/api/ui/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', agentId: 'default', goal: 'test' }),
    })

    expect(resp.status).toBe(409)
  })

  it('GET /api/ui/tasks should list tasks', async () => {
    const app = setup()

    // 创建一个 task
    await app.request('/api/ui/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', agentId: 'default', goal: 'test' }),
    })

    const resp = await app.request('/api/ui/tasks')
    expect(resp.status).toBe(200)
    const data = await resp.json() as any
    expect(data.items).toHaveLength(1)
  })

  it('GET /api/ui/tasks/:taskId should return 404 for unknown task', async () => {
    const app = setup()
    const resp = await app.request('/api/ui/tasks/nonexistent')
    expect(resp.status).toBe(404)
  })
})
```

- [ ] **Step 4: 运行测试**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose ui-tasks`
Expected: ALL PASS

- [ ] **Step 5: 提交**

```bash
git add apps/controlplane/src/routes/ui-nodes.ts apps/controlplane/src/routes/ui-tasks.ts apps/controlplane/src/routes/__tests__/ui-tasks.test.ts
git commit -m "feat(controlplane): implement Web UI REST API for nodes and tasks"
```

---

### Task 9: SSE 实时推送端点

**Files:**
- Create: `apps/controlplane/src/routes/task-stream.ts`
- Create: `apps/controlplane/src/routes/__tests__/task-stream.test.ts`

- [ ] **Step 1: 编写 task-stream.test.ts**

```typescript
import { describe, expect, it, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createDatabase, type ControlPlaneDb } from '../../db/index.js'
import { createTaskStreamRoute } from '../task-stream.js'
import { EventStore } from '../../services/event-store.js'

describe('GET /api/ui/tasks/:taskId/stream (SSE)', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    const now = Date.now()
    db.raw.prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)').run('t', now)
    db.raw.prepare(`
      INSERT INTO nodes (node_id, hostname, platform, version, access_token_hash, access_token_expires_at, enrollment_token, created_at, updated_at)
      VALUES ('n1', 'h', 'linux', '1', 'h', 999999999999999, 't', ?, ?)
    `).run(now, now)
    db.raw.prepare(`
      INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
      VALUES ('cmd-1', 'n1', 'task.run', '{}', 'leased', ?)
    `).run(now)
    db.raw.prepare(`
      INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
      VALUES ('task-1', 'cmd-1', 'n1', 'default', 'test', 'running', ?, ?)
    `).run(now, now)

    // 插入事件
    const store = new EventStore(db)
    store.insertEvent('task-1', 1, 'lifecycle', JSON.stringify({ type: 'task.started' }))
    store.insertEvent('task-1', 2, 'agent', JSON.stringify({ type: 'message.delta' }))

    const app = new Hono()
    app.route('/', createTaskStreamRoute(db))
    return app
  }

  it('should stream existing events as SSE', async () => {
    const app = setup()
    const resp = await app.request('/api/ui/tasks/task-1/stream', {
      headers: { Accept: 'text/event-stream' },
    })

    expect(resp.status).toBe(200)
    const text = await resp.text()
    expect(text).toContain('id:task-1:1')
    expect(text).toContain('id:task-1:2')
  })

  it('should resume from Last-Event-ID', async () => {
    const app = setup()
    const resp = await app.request('/api/ui/tasks/task-1/stream', {
      headers: {
        Accept: 'text/event-stream',
        'Last-Event-ID': 'task-1:1',
      },
    })

    const text = await resp.text()
    expect(text).not.toContain('id:task-1:1')
    expect(text).toContain('id:task-1:2')
  })
})
```

- [ ] **Step 2: 实现 task-stream.ts**

创建 `apps/controlplane/src/routes/task-stream.ts`：

```typescript
/**
 * SSE real-time push endpoint for task events.
 *
 * GET /api/ui/tasks/:taskId/stream
 *
 * @module routes/task-stream
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ControlPlaneDb } from '../db/index.js'
import { EventStore } from '../services/event-store.js'

export function createTaskStreamRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()
  const eventStore = new EventStore(db)

  app.get('/api/ui/tasks/:taskId/stream', (c) => {
    const taskId = c.req.param('taskId')
    const lastEventId = c.req.header('Last-Event-ID') ?? ''

    let lastSequence = 0
    if (lastEventId.includes(':')) {
      lastSequence = Number(lastEventId.split(':')[1]) || 0
    }

    return streamSSE(c, async (stream) => {
      // 先发送已有事件（catch-up）
      const existing = eventStore.getEvents(taskId, lastSequence, 1000)
      for (const event of existing) {
        const sseEventType = event.kind === 'lifecycle' ? 'task.lifecycle' : `agent.${extractAgentEventType(event.payload)}`
        await stream.writeSSE({
          event: sseEventType,
          data: JSON.stringify({
            sequence: event.sequence,
            kind: event.kind,
            payload: JSON.parse(event.payload),
            receivedAt: event.receivedAt,
          }),
          id: `${taskId}:${event.sequence}`,
        })
        lastSequence = event.sequence
      }

      // 检查 task 是否已终结
      const task = db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId) as any
      if (task && isTerminalTaskStatus(task.status)) {
        await stream.writeSSE({ event: 'done', data: '{}' })
        return
      }

      // 轮询新事件（简单实现，V4 可升级为 pub/sub）
      const maxWait = 60_000
      const start = Date.now()
      const pollInterval = 1_000
      const keepaliveInterval = 15_000
      let lastKeepalive = Date.now()

      while (Date.now() - start < maxWait) {
        const newEvents = eventStore.getEvents(taskId, lastSequence, 100)

        for (const event of newEvents) {
          const sseEventType = event.kind === 'lifecycle' ? 'task.lifecycle' : `agent.${extractAgentEventType(event.payload)}`
          await stream.writeSSE({
            event: sseEventType,
            data: JSON.stringify({
              sequence: event.sequence,
              kind: event.kind,
              payload: JSON.parse(event.payload),
              receivedAt: event.receivedAt,
            }),
            id: `${taskId}:${event.sequence}`,
          })
          lastSequence = event.sequence
        }

        // 检查终态
        const taskNow = db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId) as any
        if (taskNow && isTerminalTaskStatus(taskNow.status)) {
          await stream.writeSSE({ event: 'done', data: '{}' })
          return
        }

        // Keepalive
        if (Date.now() - lastKeepalive >= keepaliveInterval) {
          await stream.writeSSE({ event: 'keepalive', data: '' })
          lastKeepalive = Date.now()
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval))
      }
    })
  })

  return app
}

function extractAgentEventType(payload: string): string {
  try {
    const parsed = JSON.parse(payload)
    return parsed.type ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

// 使用 @tianji/shared 导出的 isTerminalTaskStatus
import { isTerminalTaskStatus } from '@tianji/shared'
```

- [ ] **Step 3: 运行测试**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose task-stream`
Expected: ALL PASS

- [ ] **Step 4: 提交**

```bash
git add apps/controlplane/src/routes/task-stream.ts apps/controlplane/src/routes/__tests__/task-stream.test.ts
git commit -m "feat(controlplane): implement SSE real-time push for task events"
```

---

### Task 10: Web UI REST API — 会话端点

**Files:**
- Create: `apps/controlplane/src/routes/ui-sessions.ts`
- Create: `apps/controlplane/src/routes/__tests__/ui-sessions.test.ts`

- [ ] **Step 1: 编写 ui-sessions.test.ts**

```typescript
import { describe, expect, it, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createDatabase, type ControlPlaneDb } from '../../db/index.js'
import { createUiSessionsRoute } from '../ui-sessions.js'

describe('UI Sessions API', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    const now = Date.now()
    db.raw.prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)').run('t', now)
    db.raw.prepare(`
      INSERT INTO nodes (node_id, hostname, platform, version, status, access_token_hash, access_token_expires_at, enrollment_token, last_heartbeat_at, created_at, updated_at)
      VALUES ('n1', 'h', 'linux', '1', 'online', 'hash', 999999999999999, 't', ?, ?, ?)
    `).run(now, now, now)

    const app = new Hono()
    app.route('/', createUiSessionsRoute(db))
    return app
  }

  it('POST /api/ui/sessions should create session metadata', async () => {
    const app = setup()
    const resp = await app.request('/api/ui/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', agentId: 'default', title: 'test session' }),
    })

    expect(resp.status).toBe(201)
    const data = await resp.json() as any
    expect(data.sessionId).toBeDefined()
    expect(data.nodeId).toBe('n1')
  })

  it('GET /api/ui/sessions should list sessions', async () => {
    const app = setup()
    await app.request('/api/ui/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', agentId: 'default' }),
    })

    const resp = await app.request('/api/ui/sessions?nodeId=n1')
    expect(resp.status).toBe(200)
    const data = await resp.json() as any
    expect(data.items).toHaveLength(1)
  })

  it('GET /api/ui/sessions/:sessionId should return session details', async () => {
    const app = setup()
    const createResp = await app.request('/api/ui/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: 'n1', agentId: 'default', title: 'test' }),
    })
    const { sessionId } = await createResp.json() as { sessionId: string }

    const resp = await app.request(`/api/ui/sessions/${sessionId}`)
    expect(resp.status).toBe(200)
    const data = await resp.json() as any
    expect(data.sessionId).toBe(sessionId)
  })
})
```

- [ ] **Step 2: 实现 ui-sessions.ts**

创建 `apps/controlplane/src/routes/ui-sessions.ts`：

```typescript
/**
 * Web UI session endpoints.
 *
 * POST   /api/ui/sessions              — 创建会话（直接聊天）
 * GET    /api/ui/sessions              — 会话列表
 * GET    /api/ui/sessions/:sessionId   — 会话详情
 *
 * @module routes/ui-sessions
 */

import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import type { ControlPlaneDb } from '../db/index.js'

export function createUiSessionsRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()

  // 创建会话
  app.post('/api/ui/sessions', async (c) => {
    const body = (await c.req.json()) as {
      nodeId: string
      agentId: string
      title?: string
    }

    const node = db.raw.prepare('SELECT status FROM nodes WHERE node_id = ?').get(body.nodeId) as any
    if (!node) return c.json({ error: 'Node not found' }, 404)
    if (node.status === 'offline') return c.json({ error: 'Node is offline' }, 409)

    const sessionId = randomUUID()
    const now = Date.now()

    db.raw.prepare(`
      INSERT INTO sessions (session_id, node_id, agent_id, title, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'user', ?, ?)
    `).run(sessionId, body.nodeId, body.agentId, body.title ?? null, now, now)

    return c.json({
      sessionId,
      nodeId: body.nodeId,
      agentId: body.agentId,
      createdAt: now,
    }, 201)
  })

  // 会话列表
  app.get('/api/ui/sessions', (c) => {
    const nodeId = c.req.query('nodeId')
    const agentId = c.req.query('agentId')
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 100)
    const cursor = c.req.query('cursor')

    let sql = 'SELECT * FROM sessions WHERE 1=1'
    const params: unknown[] = []

    if (nodeId) { sql += ' AND node_id = ?'; params.push(nodeId) }
    if (agentId) { sql += ' AND agent_id = ?'; params.push(agentId) }
    if (cursor) { sql += ' AND session_id > ?'; params.push(cursor) }

    sql += ' ORDER BY updated_at DESC LIMIT ?'
    params.push(limit + 1)

    const rows = db.raw.prepare(sql).all(...params) as any[]
    const hasMore = rows.length > limit
    const items = rows.slice(0, limit).map((row) => ({
      sessionId: row.session_id,
      nodeId: row.node_id,
      agentId: row.agent_id,
      title: row.title,
      lastRunId: row.last_run_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
    const nextCursor = hasMore ? items[items.length - 1]?.sessionId ?? null : null

    return c.json({ items, nextCursor })
  })

  // 会话详情
  app.get('/api/ui/sessions/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId')
    const row = db.raw.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as any
    if (!row) return c.json({ error: 'Session not found' }, 404)

    const linkedTaskIds = db.raw
      .prepare('SELECT task_id FROM task_sessions WHERE session_id = ?')
      .all(sessionId)
      .map((r: any) => r.task_id)

    return c.json({
      sessionId: row.session_id,
      nodeId: row.node_id,
      agentId: row.agent_id,
      title: row.title,
      linkedTaskIds,
      lastRunId: row.last_run_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  })

  return app
}
```

- [ ] **Step 3: 运行测试**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose ui-sessions`
Expected: ALL PASS

- [ ] **Step 4: 提交**

```bash
git add apps/controlplane/src/routes/ui-sessions.ts apps/controlplane/src/routes/__tests__/ui-sessions.test.ts
git commit -m "feat(controlplane): implement Web UI REST API for sessions"
```

---

### Task 11: 任务事件历史 REST 端点

**Files:**
- Create: `apps/controlplane/src/routes/ui-task-events.ts`
- Create: `apps/controlplane/src/routes/__tests__/ui-task-events.test.ts`

- [ ] **Step 1: 编写 ui-task-events.test.ts**

```typescript
import { describe, expect, it, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createDatabase, type ControlPlaneDb } from '../../db/index.js'
import { createUiTaskEventsRoute } from '../ui-task-events.js'
import { EventStore } from '../../services/event-store.js'

describe('GET /api/ui/tasks/:taskId/events', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    const now = Date.now()
    db.raw.prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)').run('t', now)
    db.raw.prepare(`
      INSERT INTO nodes (node_id, hostname, platform, version, access_token_hash, access_token_expires_at, enrollment_token, created_at, updated_at)
      VALUES ('n1', 'h', 'linux', '1', 'h', 999999999999999, 't', ?, ?)
    `).run(now, now)
    db.raw.prepare(`
      INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
      VALUES ('cmd-1', 'n1', 'task.run', '{}', 'leased', ?)
    `).run(now)
    db.raw.prepare(`
      INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
      VALUES ('task-1', 'cmd-1', 'n1', 'default', 'test', 'running', ?, ?)
    `).run(now, now)

    const store = new EventStore(db)
    store.insertEvent('task-1', 1, 'lifecycle', '{"type":"task.started"}')
    store.insertEvent('task-1', 2, 'agent', '{"type":"message.delta"}')
    store.insertEvent('task-1', 3, 'agent', '{"type":"tool.started"}')

    const app = new Hono()
    app.route('/', createUiTaskEventsRoute(db))
    return app
  }

  it('should return all events after sequence 0', async () => {
    const app = setup()
    const resp = await app.request('/api/ui/tasks/task-1/events?after=0&limit=200')
    expect(resp.status).toBe(200)
    const data = await resp.json() as any
    expect(data.items).toHaveLength(3)
    expect(data.nextSequence).toBe(4)
  })

  it('should return events after given sequence', async () => {
    const app = setup()
    const resp = await app.request('/api/ui/tasks/task-1/events?after=1&limit=200')
    const data = await resp.json() as any
    expect(data.items).toHaveLength(2)
    expect(data.items[0].sequence).toBe(2)
  })

  it('should respect limit', async () => {
    const app = setup()
    const resp = await app.request('/api/ui/tasks/task-1/events?after=0&limit=1')
    const data = await resp.json() as any
    expect(data.items).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 实现 ui-task-events.ts**

创建 `apps/controlplane/src/routes/ui-task-events.ts`：

```typescript
/**
 * GET /api/ui/tasks/:taskId/events — 任务事件历史
 *
 * @module routes/ui-task-events
 */

import { Hono } from 'hono'
import type { ControlPlaneDb } from '../db/index.js'
import { EventStore } from '../services/event-store.js'

export function createUiTaskEventsRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()
  const eventStore = new EventStore(db)

  app.get('/api/ui/tasks/:taskId/events', (c) => {
    const taskId = c.req.param('taskId')
    const after = Number(c.req.query('after') ?? 0)
    const limit = Math.min(Number(c.req.query('limit') ?? 200), 1000)

    const events = eventStore.getEvents(taskId, after, limit)

    // 检查是否有早期事件被截断
    const firstStoredSeq = db.raw.prepare(
      'SELECT MIN(sequence) as minSeq FROM task_events WHERE task_id = ?',
    ).get(taskId) as { minSeq: number | null } | undefined

    const truncated = firstStoredSeq?.minSeq !== null && firstStoredSeq!.minSeq > 1

    const items = events.map((e) => ({
      sequence: e.sequence,
      kind: e.kind,
      payload: JSON.parse(e.payload),
      receivedAt: e.receivedAt,
    }))

    const nextSequence = events.length > 0
      ? events[events.length - 1]!.sequence + 1
      : after + 1

    return c.json({ items, nextSequence, truncated })
  })

  return app
}
```

- [ ] **Step 3: 运行测试**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose ui-task-events`
Expected: ALL PASS

- [ ] **Step 4: 提交**

```bash
git add apps/controlplane/src/routes/ui-task-events.ts apps/controlplane/src/routes/__tests__/ui-task-events.test.ts
git commit -m "feat(controlplane): implement task event history REST endpoint"
```

---

### Task 12: 事件截断策略

**Files:**
- Modify: `apps/controlplane/src/services/event-store.ts`
- Modify: `apps/controlplane/src/services/__tests__/event-store.test.ts`

- [ ] **Step 1: 追加截断测试**

在 `event-store.test.ts` 末尾追加：

```typescript
describe('truncation', () => {
  it('should truncate oldest agent events when total payload exceeds limit', () => {
    const store = setup()
    // 设置较小的限制用于测试（正常为 10 MB）
    const smallLimitStore = new EventStore(db, { maxPayloadBytes: 100 })

    // 插入 lifecycle 事件（不会被截断）
    smallLimitStore.insertEvent('task-1', 1, 'lifecycle', JSON.stringify({ type: 'task.started' }))

    // 插入大量 agent 事件使总大小超过限制
    for (let i = 2; i <= 10; i++) {
      smallLimitStore.insertEvent('task-1', i, 'agent', 'x'.repeat(20))
    }

    // 触发截断
    smallLimitStore.truncateIfNeeded('task-1')

    const events = smallLimitStore.getEvents('task-1', 0, 100)
    // lifecycle 事件必须保留
    const lifecycle = events.filter((e) => e.kind === 'lifecycle')
    expect(lifecycle).toHaveLength(1)
    expect(lifecycle[0]!.sequence).toBe(1)
  })
})
```

- [ ] **Step 2: 在 EventStore 中添加截断方法**

修改 `apps/controlplane/src/services/event-store.ts`，在 `EventStore` 类中追加：

```typescript
export interface EventStoreOptions {
  /** 单任务事件 payload 总字节上限，默认 10 MB */
  readonly maxPayloadBytes?: number
}

// 修改构造函数
constructor(db: ControlPlaneDb, options?: EventStoreOptions) {
  this.#db = db
  this.#maxPayloadBytes = options?.maxPayloadBytes ?? 10 * 1024 * 1024
}

readonly #maxPayloadBytes: number

/** 检查并截断超限的 agent 事件，保留所有 lifecycle 事件 */
truncateIfNeeded(taskId: string): void {
  const sizeRow = this.#db.raw.prepare(
    'SELECT SUM(LENGTH(payload)) as totalSize FROM task_events WHERE task_id = ?',
  ).get(taskId) as { totalSize: number | null }

  if (!sizeRow?.totalSize || sizeRow.totalSize <= this.#maxPayloadBytes) return

  // 删除最旧的 agent 事件直到总大小 <= 限制
  while (true) {
    const currentSize = this.#db.raw.prepare(
      'SELECT SUM(LENGTH(payload)) as totalSize FROM task_events WHERE task_id = ?',
    ).get(taskId) as { totalSize: number | null }

    if (!currentSize?.totalSize || currentSize.totalSize <= this.#maxPayloadBytes) break

    const oldest = this.#db.raw.prepare(`
      SELECT sequence FROM task_events
      WHERE task_id = ? AND kind = 'agent'
      ORDER BY sequence ASC LIMIT 1
    `).get(taskId) as { sequence: number } | undefined

    if (!oldest) break

    this.#db.raw.prepare(
      'DELETE FROM task_events WHERE task_id = ? AND sequence = ?',
    ).run(taskId, oldest.sequence)
  }
}
```

同时在 `insertEvent` 末尾调用 `this.truncateIfNeeded(taskId)`。

- [ ] **Step 3: 运行测试**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose event-store`
Expected: ALL PASS

- [ ] **Step 4: 提交**

```bash
git add apps/controlplane/src/services/event-store.ts apps/controlplane/src/services/__tests__/event-store.test.ts
git commit -m "feat(controlplane): implement event truncation strategy — keep lifecycle, trim agent events"
```

---

### Task 13: observation_lost 状态转换

**Files:**
- Create: `apps/controlplane/src/services/observation-monitor.ts`
- Create: `apps/controlplane/src/services/__tests__/observation-monitor.test.ts`

- [ ] **Step 1: 编写 observation-monitor.test.ts**

```typescript
import { describe, expect, it, afterEach } from 'vitest'
import { createDatabase, type ControlPlaneDb } from '../../db/index.js'
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
    db.raw.prepare(`
      INSERT INTO nodes (node_id, hostname, platform, version, status, access_token_hash, access_token_expires_at, enrollment_token, last_heartbeat_at, created_at, updated_at)
      VALUES ('n1', 'h', 'linux', '1', 'online', 'h', 999999999999999, 't', ?, ?, ?)
    `).run(now, now, now)
    db.raw.prepare(`
      INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
      VALUES ('cmd-1', 'n1', 'task.run', '{}', 'leased', ?)
    `).run(now)
    return now
  }

  it('should mark running tasks as observation_lost when node goes offline', () => {
    const now = setup()
    db.raw.prepare(`
      INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
      VALUES ('task-1', 'cmd-1', 'n1', 'a', 'g', 'running', ?, ?)
    `).run(now, now)

    // 模拟 node offline（心跳超时）
    db.raw.prepare('UPDATE nodes SET last_heartbeat_at = ?, status = ? WHERE node_id = ?')
      .run(now - 120_000, 'offline', 'n1')

    const monitor = new ObservationMonitor(db)
    monitor.checkOfflineNodes()

    const task = db.raw.prepare('SELECT status, failure_reason FROM tasks WHERE task_id = ?')
      .get('task-1') as any
    expect(task.status).toBe('observation_lost')
    expect(task.failure_reason).toBe('observation_lost')
  })

  it('should not affect tasks in terminal states', () => {
    const now = setup()
    db.raw.prepare(`
      INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
      VALUES ('task-1', 'cmd-1', 'n1', 'a', 'g', 'completed', ?, ?)
    `).run(now, now)

    db.raw.prepare('UPDATE nodes SET last_heartbeat_at = ?, status = ? WHERE node_id = ?')
      .run(now - 120_000, 'offline', 'n1')

    const monitor = new ObservationMonitor(db)
    monitor.checkOfflineNodes()

    const task = db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?')
      .get('task-1') as any
    expect(task.status).toBe('completed')
  })
})
```

- [ ] **Step 2: 实现 observation-monitor.ts**

创建 `apps/controlplane/src/services/observation-monitor.ts`：

```typescript
/**
 * Monitors node liveness and transitions tasks to observation_lost.
 *
 * 定期检查 offline node 上的 active tasks，将其标记为 observation_lost。
 *
 * @module services/observation-monitor
 */

import type { ControlPlaneDb } from '../db/index.js'
import { HEARTBEAT_TIMEOUT_MS } from '../routes/node-heartbeat.js'

export class ObservationMonitor {
  readonly #db: ControlPlaneDb
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(db: ControlPlaneDb) {
    this.#db = db
  }

  /** 启动定期检查（每 30s） */
  start(intervalMs = 30_000): void {
    this.#timer = setInterval(() => this.checkOfflineNodes(), intervalMs)
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /** 检查 offline node 上的 running/waiting tasks，标记为 observation_lost */
  checkOfflineNodes(): void {
    const now = Date.now()
    const threshold = now - HEARTBEAT_TIMEOUT_MS

    // 找到心跳超时的 node
    const offlineNodes = this.#db.raw.prepare(`
      SELECT node_id FROM nodes
      WHERE last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?
    `).all(threshold) as { node_id: string }[]

    for (const { node_id } of offlineNodes) {
      // 更新 node 状态为 offline
      this.#db.raw.prepare('UPDATE nodes SET status = ? WHERE node_id = ? AND status = ?')
        .run('offline', node_id, 'online')

      // 将 running/waiting tasks 标记为 observation_lost
      this.#db.raw.prepare(`
        UPDATE tasks SET status = 'observation_lost', failure_reason = 'observation_lost', updated_at = ?
        WHERE node_id = ? AND status IN ('running', 'waiting')
      `).run(now, node_id)

      // 同步更新关联 commands
      this.#db.raw.prepare(`
        UPDATE commands SET state = 'observation_lost'
        WHERE node_id = ? AND state IN ('leased', 'running')
      `).run(node_id)
    }
  }
}
```

- [ ] **Step 3: 运行测试**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose observation-monitor`
Expected: ALL PASS

- [ ] **Step 4: 提交**

```bash
git add apps/controlplane/src/services/observation-monitor.ts apps/controlplane/src/services/__tests__/observation-monitor.test.ts
git commit -m "feat(controlplane): implement observation_lost state transition for offline nodes"
```

---

### Task 14: 组装 Hono 应用并添加服务器入口（含 observation monitor）

**Files:**
- Modify: `apps/controlplane/src/app.ts`
- Create: `apps/controlplane/src/server.ts`

- [ ] **Step 1: 组装所有路由到 app.ts**

更新 `apps/controlplane/src/app.ts`：

```typescript
import { Hono } from 'hono'
import type { ControlPlaneDb } from './db/index.js'
import { createNodeRegisterRoute } from './routes/node-register.js'
import { createNodeHeartbeatRoute } from './routes/node-heartbeat.js'
import { createCommandPollRoute } from './routes/command-poll.js'
import { createTaskEventsRoute } from './routes/task-events.js'
import { createUiNodesRoute } from './routes/ui-nodes.js'
import { createUiTasksRoute } from './routes/ui-tasks.js'
import { createUiSessionsRoute } from './routes/ui-sessions.js'
import { createUiTaskEventsRoute } from './routes/ui-task-events.js'
import { createTaskStreamRoute } from './routes/task-stream.js'
import { ObservationMonitor } from './services/observation-monitor.js'

export function createApp(db: ControlPlaneDb): { app: Hono; monitor: ObservationMonitor } {
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))

  // Node 端点
  app.route('/', createNodeRegisterRoute(db))
  app.route('/', createNodeHeartbeatRoute(db))
  app.route('/', createCommandPollRoute(db))
  app.route('/', createTaskEventsRoute(db))

  // Web UI 端点
  app.route('/', createUiNodesRoute(db))
  app.route('/', createUiTasksRoute(db))
  app.route('/', createUiSessionsRoute(db))
  app.route('/', createUiTaskEventsRoute(db))
  app.route('/', createTaskStreamRoute(db))

  // observation_lost 监控
  const monitor = new ObservationMonitor(db)

  return { app, monitor }
}
```

- [ ] **Step 2: 创建 server.ts 入口**

创建 `apps/controlplane/src/server.ts`：

```typescript
/**
 * Control Plane HTTP server entry point.
 *
 * 用法：node dist/server.js [--port 3000] [--db-path ./data/controlplane.db]
 */

import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { createDatabase } from './db/index.js'

const port = Number(process.env.TIANJI_CP_PORT ?? 7800)
const host = process.env.TIANJI_CP_HOST ?? '0.0.0.0'
const dataDir = process.env.TIANJI_CP_DATA_DIR ?? `${process.env.HOME}/.config/tianji-ai/controlplane`
const dbPath = `${dataDir}/controlplane.db`

// 确保数据目录存在
import { mkdirSync } from 'node:fs'
mkdirSync(dataDir, { recursive: true })

const db = createDatabase(dbPath)
const { app, monitor } = createApp(db)
monitor.start()

const server = serve({ fetch: app.fetch, port, hostname: host })

console.log(`Control Plane listening on ${host}:${port}`)
console.log(`Database: ${dbPath}`)

const shutdown = () => {
  console.log('Shutting down...')
  monitor.stop()
  db.close()
  server.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

- [ ] **Step 3: 更新 index.ts 导出**

更新 `apps/controlplane/src/index.ts`：

```typescript
export { createApp } from './app.js'
export { createDatabase } from './db/index.js'
```

- [ ] **Step 4: 运行 pnpm check**

Run: `pnpm check`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add apps/controlplane/src/app.ts apps/controlplane/src/server.ts apps/controlplane/src/index.ts
git commit -m "feat(controlplane): assemble all routes and create server entry point"
```

---

### Task 15: 全量回归测试

**Files:**
- 无新增文件

- [ ] **Step 1: 运行 controlplane 全量测试**

Run: `cd apps/controlplane && pnpm test -- --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 2: 运行全局 pnpm check**

Run: `pnpm check`
Expected: 无错误

- [ ] **Step 3: 构建验证**

Run: `cd apps/controlplane && pnpm build`
Expected: 编译成功

- [ ] **Step 4: 冒烟测试服务器启动**

Run: `cd apps/controlplane && timeout 3 node dist/server.js 2>&1 || true`
Expected: 输出 "Control Plane listening on port 3000"，3 秒后超时退出
