# Controlplane 结构化日志 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 controlplane 所有关键服务事件添加基于 `@tianji/observer` 的结构化日志，同时输出到文件（与 daemon 共用 `tianji.log`）和 stdout。

**Architecture:** 新增 `services/logger.ts` 工厂模块，创建双 sink（JSONL 文件 + stdout pretty）的 `ObserverLogger`。logger 实例在 `server.ts` 创建后通过 `createApp(db, logger)` 注入各路由和服务。日志级别严格区分：debug 用于常规操作（心跳、认证成功），info 用于状态变更（注册、启动），warn 用于异常（认证失败、离线检测）。

**Tech Stack:** `@tianji/observer`（`createObserverLogger`, `createJsonlFileSink`, `createStdoutSink`）、Hono、Vitest

---

## 文件结构

| 操作 | 文件路径 | 职责 |
|------|---------|------|
| Modify | `packages/observer/src/index.ts` | 导出 `createJsonlFileSink`、`createStdoutSink` |
| Create | `apps/controlplane/src/services/logger.ts` | controlplane logger 工厂 |
| Create | `apps/controlplane/src/services/__tests__/logger.test.ts` | logger 工厂测试 |
| Modify | `apps/controlplane/src/app.ts` | `createApp` 接受 logger 参数并传递给子模块 |
| Modify | `apps/controlplane/src/server.ts` | 创建 logger 实例，替换 `console.log` |
| Modify | `apps/controlplane/src/routes/node-register.ts` | 注册日志 |
| Modify | `apps/controlplane/src/routes/__tests__/node-register.test.ts` | 注册测试适配 logger |
| Modify | `apps/controlplane/src/routes/node-heartbeat.ts` | 心跳日志 |
| Modify | `apps/controlplane/src/routes/__tests__/node-heartbeat.test.ts` | 心跳测试适配 logger |
| Modify | `apps/controlplane/src/middleware/auth.ts` | 认证日志 |
| Modify | `apps/controlplane/src/services/observation-monitor.ts` | 离线检测日志 |
| Modify | `apps/controlplane/src/services/__tests__/observation-monitor.test.ts` | 离线检测测试适配 logger |

---

### Task 1: 导出 observer sink 工厂

`createJsonlFileSink` 和 `createStdoutSink` 已实现在 `packages/observer/src/logger/sinks/` 中，但未从包级 `index.ts` 导出。

**Files:**
- Modify: `packages/observer/src/index.ts`

- [ ] **Step 1: 补充导出**

在 `packages/observer/src/index.ts` 中，将现有的：

```typescript
export {
  createObserverLogger,
  createMemorySink,
  getDefaultObserverSensitiveKeys,
  sanitizeObserverLogData,
} from './logger/index.js'
```

改为：

```typescript
export {
  createObserverLogger,
  createJsonlFileSink,
  createMemorySink,
  createStdoutSink,
  getDefaultObserverSensitiveKeys,
  sanitizeObserverLogData,
} from './logger/index.js'
```

同时补充类型导出：

```typescript
export type {
  ObserverLogEntry,
  ObserverLogger,
  ObserverLogLevel,
  ObserverLogScope,
  ObserverLogSink,
} from './types.js'

export type { CreateJsonlFileSinkOptions } from './logger/index.js'
export type { CreateStdoutSinkOptions } from './logger/index.js'
```

注意：需要确认 `packages/observer/src/logger/index.ts` 已导出这些 sink（已确认有）和选项类型（需检查 `CreateStdoutSinkOptions` 是否已导出，若未导出则在 `logger/index.ts` 补充）。

- [ ] **Step 2: 确认 logger/index.ts 导出类型**

确保 `packages/observer/src/logger/index.ts` 同时导出了 `CreateJsonlFileSinkOptions` 和 `CreateStdoutSinkOptions` 类型：

```typescript
export type { CreateJsonlFileSinkOptions } from './sinks/file-jsonl.js'
export type { CreateStdoutSinkOptions } from './sinks/stdout.js'
```

- [ ] **Step 3: 运行 typecheck 验证**

Run: `cd packages/observer && pnpm typecheck`
Expected: 编译通过，无错误

- [ ] **Step 4: 提交**

```bash
git add packages/observer/src/index.ts packages/observer/src/logger/index.ts
git commit -m "feat(observer): 导出 createJsonlFileSink 和 createStdoutSink sink 工厂"
```

---

### Task 2: 创建 controlplane logger 工厂

**Files:**
- Create: `apps/controlplane/src/services/logger.ts`
- Create: `apps/controlplane/src/services/__tests__/logger.test.ts`

- [ ] **Step 1: 编写 logger 工厂测试**

创建 `apps/controlplane/src/services/__tests__/logger.test.ts`：

```typescript
import { describe, expect, it } from 'vitest'
import { createMemorySink } from '@tianji/observer'

import { createControlPlaneLogger } from '../logger.js'

describe('createControlPlaneLogger', () => {
  it('should write log entries to all provided sinks', async () => {
    const sink = createMemorySink()
    const logger = createControlPlaneLogger({ sinks: [sink] })

    await logger.info(['controlplane', 'test'], 'hello')

    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0].level).toBe('info')
    expect(sink.entries[0].scope).toEqual(['controlplane', 'test'])
    expect(sink.entries[0].message).toBe('hello')
  })

  it('should attach structured data to log entry', async () => {
    const sink = createMemorySink()
    const logger = createControlPlaneLogger({ sinks: [sink] })

    await logger.info(['controlplane', 'register'], 'node registered', {
      nodeId: 'n1',
    })

    expect(sink.entries[0].data).toEqual({ nodeId: 'n1' })
  })

  it('should support debug level', async () => {
    const sink = createMemorySink()
    const logger = createControlPlaneLogger({ sinks: [sink] })

    await logger.debug(['controlplane', 'heartbeat'], 'heartbeat received')

    expect(sink.entries[0].level).toBe('debug')
  })

  it('should support warn level', async () => {
    const sink = createMemorySink()
    const logger = createControlPlaneLogger({ sinks: [sink] })

    await logger.warn(['controlplane', 'auth'], 'invalid token')

    expect(sink.entries[0].level).toBe('warn')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/controlplane && pnpm test -- src/services/__tests__/logger.test.ts`
Expected: FAIL，`createControlPlaneLogger` 不存在

- [ ] **Step 3: 实现 logger 工厂**

创建 `apps/controlplane/src/services/logger.ts`：

```typescript
import type { ObserverLogger, ObserverLogSink } from '@tianji/observer'
import { createObserverLogger } from '@tianji/observer'

export interface CreateControlPlaneLoggerOptions {
  readonly sinks: readonly ObserverLogSink[]
}

/**
 * 创建 controlplane 专用的结构化 logger。
 *
 * @param options - sink 列表，通常包含文件 sink 和 stdout sink
 */
export function createControlPlaneLogger(
  options: CreateControlPlaneLoggerOptions
): ObserverLogger {
  return createObserverLogger({ sinks: options.sinks })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/controlplane && pnpm test -- src/services/__tests__/logger.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/controlplane/src/services/logger.ts apps/controlplane/src/services/__tests__/logger.test.ts
git commit -m "feat(controlplane): 添加 createControlPlaneLogger 工厂"
```

---

### Task 3: 改造 createApp 接受 logger 参数

**Files:**
- Modify: `apps/controlplane/src/app.ts`
- Modify: `apps/controlplane/src/__tests__/app.test.ts`（如果存在且需要适配）

- [ ] **Step 1: 读取现有 app.test.ts**

读取 `apps/controlplane/src/__tests__/app.test.ts` 了解现有测试如何调用 `createApp`。

- [ ] **Step 2: 修改 createApp 签名**

修改 `apps/controlplane/src/app.ts`：

```typescript
import type { ObserverLogger } from '@tianji/observer'
import { Hono } from 'hono'

import type { ControlPlaneDb } from './db/index.js'
import { createCommandPollRoute } from './routes/command-poll.js'
import { createNodeHeartbeatRoute } from './routes/node-heartbeat.js'
import { createNodeRegisterRoute } from './routes/node-register.js'
import { createTaskEventsRoute } from './routes/task-events.js'
import { createTaskStreamRoute } from './routes/task-stream.js'
import { createUiNodesRoute } from './routes/ui-nodes.js'
import { createUiSessionsRoute } from './routes/ui-sessions.js'
import { createUiTaskEventsRoute } from './routes/ui-task-events.js'
import { createUiTasksRoute } from './routes/ui-tasks.js'
import { createWebUiRoute } from './routes/web-ui.js'
import { ObservationMonitor } from './services/observation-monitor.js'

export interface ControlPlaneApp {
  readonly app: Hono
  readonly monitor: ObservationMonitor
}

/**
 * 创建 controlplane HTTP 应用。
 */
export function createApp(db: ControlPlaneDb, logger: ObserverLogger): ControlPlaneApp {
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))

  app.route('/', createNodeRegisterRoute(db, logger))
  app.route('/', createNodeHeartbeatRoute(db, logger))
  app.route('/', createCommandPollRoute(db))
  app.route('/', createTaskEventsRoute(db))

  app.route('/', createUiNodesRoute(db))
  app.route('/', createUiTasksRoute(db))
  app.route('/', createUiSessionsRoute(db))
  app.route('/', createUiTaskEventsRoute(db))
  app.route('/', createTaskStreamRoute(db))
  app.route('/', createWebUiRoute())

  return {
    app,
    monitor: new ObservationMonitor(db, logger),
  }
}
```

注意：`createNodeHeartbeatRoute` 内部使用 `createAuthMiddleware`，也需要传递 logger。具体做法是 `createNodeHeartbeatRoute` 内部调用 `createAuthMiddleware(db, logger)`。

- [ ] **Step 3: 更新所有调用 createApp 的测试**

所有测试文件中 `createApp(db)` 改为 `createApp(db, logger)`，其中 logger 用 `createMemorySink` 构造的 noop logger。

对 `app.test.ts` 中的 setup：

```typescript
import { createMemorySink, createObserverLogger } from '@tianji/observer'

const sink = createMemorySink()
const logger = createObserverLogger({ sinks: [sink] })
const { app } = createApp(db, logger)
```

- [ ] **Step 4: 运行全量测试**

Run: `cd apps/controlplane && pnpm test`
Expected: 编译失败，因为子路由签名还没改。这一步先不提交，继续 Task 4-7 后统一验证。

---

### Task 4: 注册路由添加日志

**Files:**
- Modify: `apps/controlplane/src/routes/node-register.ts`
- Modify: `apps/controlplane/src/routes/__tests__/node-register.test.ts`

- [ ] **Step 1: 更新注册测试，验证日志输出**

修改 `apps/controlplane/src/routes/__tests__/node-register.test.ts`，在 setup 中注入 logger 并验证日志：

```typescript
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemorySink, createObserverLogger } from '@tianji/observer'
import type { ObserverMemorySink } from '@tianji/observer'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { createNodeRegisterRoute } from '../node-register.js'

describe('POST /api/nodes/register', () => {
  let db: ControlPlaneDb
  let sink: ObserverMemorySink

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    db.raw
      .prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)')
      .run('valid-token', Date.now())

    sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })

    const app = new Hono()
    app.route('/', createNodeRegisterRoute(db, logger))

    return app
  }

  it('should register a new node and return access token', async () => {
    const app = setup()
    const response = await app.request('/api/nodes/register', {
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

    expect(response.status).toBe(200)

    const data = (await response.json()) as { accessToken: string; expiresAt: number }
    expect(data.accessToken).toBeDefined()
    expect(data.expiresAt).toBeGreaterThan(Date.now())

    const infoLogs = sink.entries.filter((e) => e.level === 'info')
    expect(infoLogs).toHaveLength(1)
    expect(infoLogs[0].message).toBe('New node registered')
    expect(infoLogs[0].data).toMatchObject({ nodeId: 'node-001', hostname: 'dev-machine' })
  })

  it('should reject invalid enrollment token', async () => {
    const app = setup()
    const response = await app.request('/api/nodes/register', {
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

    expect(response.status).toBe(403)

    const warnLogs = sink.entries.filter((e) => e.level === 'warn')
    expect(warnLogs).toHaveLength(1)
    expect(warnLogs[0].message).toBe('Registration rejected: invalid enrollment token')
  })

  it('should re-register existing node with new access token', async () => {
    const app = setup()

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

    const response = await app.request('/api/nodes/register', {
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

    expect(response.status).toBe(200)

    const node = db.raw
      .prepare('SELECT hostname, version FROM nodes WHERE node_id = ?')
      .get('node-001') as { hostname: string; version: string }
    expect(node.hostname).toBe('dev-1-updated')
    expect(node.version).toBe('3.1.0')

    const infoLogs = sink.entries.filter((e) => e.level === 'info')
    expect(infoLogs[1].message).toBe('Node re-registered')
    expect(infoLogs[1].data).toMatchObject({ nodeId: 'node-001' })
  })
})
```

注意：需要确认 `ObserverMemorySink` 类型是否已从 `@tianji/observer` 导出。若未导出，需在 Task 1 中一并补充。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/controlplane && pnpm test -- src/routes/__tests__/node-register.test.ts`
Expected: FAIL，`createNodeRegisterRoute` 签名不匹配

- [ ] **Step 3: 实现注册路由日志**

修改 `apps/controlplane/src/routes/node-register.ts`：

```typescript
import type { AgentInfo, NodeRegisterRequest, NodeRegisterResponse } from '@tianji/shared'
import type { ObserverLogger } from '@tianji/observer'
import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { ACCESS_TOKEN_TTL_MS, generateAccessToken, hashToken } from '../services/auth.js'

const SCOPE_REGISTER = ['controlplane', 'register'] as const

/**
 * 创建 node 注册路由。
 */
export function createNodeRegisterRoute(db: ControlPlaneDb, logger: ObserverLogger): Hono {
  const app = new Hono()

  app.post('/api/nodes/register', async (c) => {
    const body = (await c.req.json()) as NodeRegisterRequest // NOSONAR
    const tokenRow = db.raw
      .prepare('SELECT token FROM enrollment_tokens WHERE token = ?')
      .get(body.enrollmentToken)

    if (tokenRow === undefined) {
      await logger.warn(SCOPE_REGISTER, 'Registration rejected: invalid enrollment token')
      return c.json({ error: 'Invalid enrollment token' }, 403)
    }

    const accessToken = generateAccessToken()
    const accessTokenHash = hashToken(accessToken)
    const now = Date.now()
    const expiresAt = now + ACCESS_TOKEN_TTL_MS
    const existingNode = db.raw
      .prepare('SELECT node_id FROM nodes WHERE node_id = ?')
      .get(body.nodeId)

    if (existingNode === undefined) {
      db.raw
        .prepare(
          `INSERT INTO nodes (
            node_id, hostname, platform, version, status,
            execution_state, access_token_hash, access_token_expires_at,
            enrollment_token, last_heartbeat_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'online', 'idle', ?, ?, ?, ?, ?, ?)`
        )
        .run(
          body.nodeId,
          body.hostname,
          body.platform,
          body.version,
          accessTokenHash,
          expiresAt,
          body.enrollmentToken,
          now,
          now,
          now
        )
      await logger.info(SCOPE_REGISTER, 'New node registered', {
        nodeId: body.nodeId,
        hostname: body.hostname,
        platform: body.platform,
        agentCount: body.agentList.length,
      })
    } else {
      db.raw
        .prepare(
          `UPDATE nodes SET
            hostname = ?,
            platform = ?,
            version = ?,
            status = 'online',
            access_token_hash = ?,
            access_token_expires_at = ?,
            last_heartbeat_at = ?,
            updated_at = ?
          WHERE node_id = ?`
        )
        .run(
          body.hostname,
          body.platform,
          body.version,
          accessTokenHash,
          expiresAt,
          now,
          now,
          body.nodeId
        )
      await logger.info(SCOPE_REGISTER, 'Node re-registered', {
        nodeId: body.nodeId,
        hostname: body.hostname,
        platform: body.platform,
        agentCount: body.agentList.length,
      })
    }

    updateAgentList(db, body.nodeId, body.agentList, now)

    const response: NodeRegisterResponse = {
      accessToken,
      expiresAt,
    }

    return c.json(response)
  })

  return app
}

/**
 * 使用全量快照覆盖 node 的 agent 列表。
 */
export function updateAgentList(
  db: ControlPlaneDb,
  nodeId: string,
  agentList: readonly AgentInfo[],
  now: number
): void {
  db.raw.prepare('DELETE FROM agents WHERE node_id = ?').run(nodeId)

  const insert = db.raw.prepare(
    'INSERT INTO agents (node_id, agent_id, type, name, version, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  )

  for (const agent of agentList) {
    insert.run(nodeId, agent.agentId, agent.type, agent.name, agent.version, now)
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/controlplane && pnpm test -- src/routes/__tests__/node-register.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/controlplane/src/routes/node-register.ts apps/controlplane/src/routes/__tests__/node-register.test.ts
git commit -m "feat(controlplane): 注册路由添加结构化日志"
```

---

### Task 5: 认证中间件添加日志

**Files:**
- Modify: `apps/controlplane/src/middleware/auth.ts`

- [ ] **Step 1: 实现认证中间件日志**

修改 `apps/controlplane/src/middleware/auth.ts`：

```typescript
import type { Context, Next } from 'hono'
import type { ObserverLogger } from '@tianji/observer'

import type { ControlPlaneDb } from '../db/index.js'
import { hashToken } from '../services/auth.js'

const SCOPE_AUTH = ['controlplane', 'auth'] as const

/**
 * 创建 Bearer token 认证中间件。
 */
export function createAuthMiddleware(db: ControlPlaneDb, logger: ObserverLogger) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      await logger.warn(SCOPE_AUTH, 'Missing authorization header', { path: c.req.path })
      return c.json({ error: 'Missing authorization' }, 401)
    }

    const token = authHeader.slice(7)
    const tokenHash = hashToken(token)
    const now = Date.now()
    const node = db.raw
      .prepare(
        `SELECT node_id FROM nodes
         WHERE access_token_hash = ? AND access_token_expires_at > ?`
      )
      .get(tokenHash, now) as { node_id: string } | undefined

    if (node === undefined) {
      await logger.warn(SCOPE_AUTH, 'Invalid or expired token', { path: c.req.path })
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    await logger.debug(SCOPE_AUTH, 'Authentication succeeded', { nodeId: node.node_id })
    c.set('nodeId', node.node_id)
    await next()
  }
}
```

- [ ] **Step 2: 运行测试验证编译**

此时还无法单独运行测试，在 Task 6 中和心跳路由一起验证。

---

### Task 6: 心跳路由添加日志

**Files:**
- Modify: `apps/controlplane/src/routes/node-heartbeat.ts`
- Modify: `apps/controlplane/src/routes/__tests__/node-heartbeat.test.ts`

- [ ] **Step 1: 更新心跳测试**

修改 `apps/controlplane/src/routes/__tests__/node-heartbeat.test.ts`：

```typescript
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemorySink, createObserverLogger } from '@tianji/observer'
import type { ObserverMemorySink } from '@tianji/observer'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { createNodeHeartbeatRoute } from '../node-heartbeat.js'
import { createNodeRegisterRoute } from '../node-register.js'

describe('POST /api/nodes/:nodeId/heartbeat', () => {
  let db: ControlPlaneDb
  let accessToken: string
  let sink: ObserverMemorySink

  afterEach(() => {
    db?.close()
  })

  async function setup() {
    db = createDatabase(':memory:')
    db.raw
      .prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)')
      .run('valid-token', Date.now())

    sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })

    const app = new Hono()
    app.route('/', createNodeRegisterRoute(db, logger))
    app.route('/', createNodeHeartbeatRoute(db, logger))

    const response = await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-001',
        enrollmentToken: 'valid-token',
        hostname: 'dev',
        platform: 'linux',
        version: '3.0.0',
        agentList: [{ agentId: 'default', type: 'native', name: 'default', version: '3.0.0' }],
      }),
    })

    const data = (await response.json()) as { accessToken: string }
    accessToken = data.accessToken

    return app
  }

  it('should accept heartbeat and update last_heartbeat_at', async () => {
    const app = await setup()
    sink.entries.length = 0 // 清除注册日志

    const response = await app.request('/api/nodes/node-001/heartbeat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ executionState: 'idle' }),
    })

    expect(response.status).toBe(204)

    const node = db.raw
      .prepare('SELECT last_heartbeat_at, execution_state FROM nodes WHERE node_id = ?')
      .get('node-001') as { last_heartbeat_at: number; execution_state: string }
    expect(node.execution_state).toBe('idle')
    expect(node.last_heartbeat_at).toBeGreaterThan(0)

    const debugLogs = sink.entries.filter((e) => e.level === 'debug')
    expect(debugLogs.some((e) => e.message === 'Heartbeat received')).toBe(true)
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

    const node = db.raw
      .prepare('SELECT execution_state FROM nodes WHERE node_id = ?')
      .get('node-001') as { execution_state: string }
    expect(node.execution_state).toBe('busy')
  })

  it('should reject without auth token', async () => {
    const app = await setup()
    sink.entries.length = 0

    const response = await app.request('/api/nodes/node-001/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionState: 'idle' }),
    })

    expect(response.status).toBe(401)

    const warnLogs = sink.entries.filter((e) => e.level === 'warn')
    expect(warnLogs.some((e) => e.message === 'Missing authorization header')).toBe(true)
  })
})
```

- [ ] **Step 2: 实现心跳路由日志**

修改 `apps/controlplane/src/routes/node-heartbeat.ts`：

```typescript
import type { NodeHeartbeatRequest } from '@tianji/shared'
import type { ObserverLogger } from '@tianji/observer'
import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { createAuthMiddleware } from '../middleware/auth.js'
import { updateAgentList } from './node-register.js'

type AuthVariables = {
  Variables: {
    nodeId: string
  }
}

const SCOPE_HEARTBEAT = ['controlplane', 'heartbeat'] as const

/** 心跳超时阈值（90s 无心跳标记 offline）。 */
export const HEARTBEAT_TIMEOUT_MS = 90_000

/**
 * 创建 node 心跳路由。
 */
export function createNodeHeartbeatRoute(
  db: ControlPlaneDb,
  logger: ObserverLogger
): Hono<AuthVariables> {
  const app = new Hono<AuthVariables>()
  const auth = createAuthMiddleware(db, logger)

  app.post('/api/nodes/:nodeId/heartbeat', auth, async (c) => {
    const nodeId = c.req.param('nodeId')
    const authenticatedNodeId = c.get('nodeId') as string // NOSONAR

    if (nodeId !== authenticatedNodeId) {
      await logger.warn(SCOPE_HEARTBEAT, 'Node ID mismatch', {
        nodeId,
        authenticatedNodeId,
      })
      return c.json({ error: 'Node ID mismatch' }, 403)
    }

    const body = (await c.req.json()) as NodeHeartbeatRequest // NOSONAR
    const now = Date.now()

    db.raw
      .prepare(
        `UPDATE nodes SET
          status = 'online',
          execution_state = ?,
          last_heartbeat_at = ?,
          updated_at = ?
        WHERE node_id = ?`
      )
      .run(body.executionState, now, now, nodeId)

    if (body.agentList !== undefined) {
      updateAgentList(db, nodeId, body.agentList, now)
    }

    await logger.debug(SCOPE_HEARTBEAT, 'Heartbeat received', {
      nodeId,
      executionState: body.executionState,
    })

    return c.body(null, 204)
  })

  return app
}
```

- [ ] **Step 3: 运行心跳测试**

Run: `cd apps/controlplane && pnpm test -- src/routes/__tests__/node-heartbeat.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add apps/controlplane/src/routes/node-heartbeat.ts apps/controlplane/src/routes/__tests__/node-heartbeat.test.ts apps/controlplane/src/middleware/auth.ts
git commit -m "feat(controlplane): 心跳路由和认证中间件添加结构化日志"
```

---

### Task 7: 离线检测添加日志

**Files:**
- Modify: `apps/controlplane/src/services/observation-monitor.ts`
- Modify: `apps/controlplane/src/services/__tests__/observation-monitor.test.ts`

- [ ] **Step 1: 更新离线检测测试**

修改 `apps/controlplane/src/services/__tests__/observation-monitor.test.ts`：

```typescript
import { afterEach, describe, expect, it } from 'vitest'
import { createMemorySink, createObserverLogger } from '@tianji/observer'
import type { ObserverMemorySink } from '@tianji/observer'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { ObservationMonitor } from '../observation-monitor.js'

describe('ObservationMonitor', () => {
  let db: ControlPlaneDb
  let sink: ObserverMemorySink

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    sink = createMemorySink()
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

    const logger = createObserverLogger({ sinks: [sink] })
    const monitor = new ObservationMonitor(db, logger)
    monitor.checkOfflineNodes()

    const task = db.raw
      .prepare('SELECT status, failure_reason FROM tasks WHERE task_id = ?')
      .get('task-1') as { status: string; failure_reason: string }
    expect(task.status).toBe('observation_lost')
    expect(task.failure_reason).toBe('observation_lost')

    const warnLogs = sink.entries.filter((e) => e.level === 'warn')
    expect(warnLogs.some((e) => e.message === 'Node marked offline')).toBe(true)
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

    const logger = createObserverLogger({ sinks: [sink] })
    const monitor = new ObservationMonitor(db, logger)
    monitor.checkOfflineNodes()

    const task = db.raw.prepare('SELECT status FROM tasks WHERE task_id = ?').get('task-1') as {
      status: string
    }
    expect(task.status).toBe('completed')
  })
})
```

- [ ] **Step 2: 实现离线检测日志**

修改 `apps/controlplane/src/services/observation-monitor.ts`：

```typescript
import type { ObserverLogger } from '@tianji/observer'

import type { ControlPlaneDb } from '../db/index.js'
import { HEARTBEAT_TIMEOUT_MS } from '../routes/node-heartbeat.js'

const SCOPE_MONITOR = ['controlplane', 'monitor'] as const

/**
 * 监控离线 node，并把活动任务转为 observation_lost。
 */
export class ObservationMonitor {
  readonly #db: ControlPlaneDb
  readonly #logger: ObserverLogger
  #timer: ReturnType<typeof setInterval> | null = null

  constructor(db: ControlPlaneDb, logger: ObserverLogger) {
    this.#db = db
    this.#logger = logger
  }

  /** 启动周期检查。 */
  start(intervalMs = 30_000): void {
    this.#timer = setInterval(() => this.checkOfflineNodes(), intervalMs)
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /**
   * 将心跳超时 node 上的 running/waiting 任务转为 observation_lost。
   */
  checkOfflineNodes(): void {
    const now = Date.now()
    const threshold = now - HEARTBEAT_TIMEOUT_MS
    const offlineNodes = this.#db.raw
      .prepare(
        `SELECT node_id FROM nodes
         WHERE last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?`
      )
      .all(threshold) as Array<{ node_id: string }>

    for (const { node_id: nodeId } of offlineNodes) {
      const statusChange = this.#db.raw
        .prepare('UPDATE nodes SET status = ? WHERE node_id = ? AND status = ?')
        .run('offline', nodeId, 'online')

      if (statusChange.changes > 0) {
        void this.#logger.warn(SCOPE_MONITOR, 'Node marked offline', { nodeId })
      }

      const taskChange = this.#db.raw
        .prepare(
          `UPDATE tasks SET status = 'observation_lost', failure_reason = 'observation_lost', updated_at = ?
           WHERE node_id = ? AND status IN ('running', 'waiting')`
        )
        .run(now, nodeId)

      if (taskChange.changes > 0) {
        void this.#logger.warn(SCOPE_MONITOR, 'Tasks marked as observation_lost', {
          nodeId,
          taskCount: taskChange.changes,
        })
      }

      this.#db.raw
        .prepare(
          `UPDATE commands SET state = 'observation_lost'
           WHERE node_id = ? AND state IN ('leased', 'running')`
        )
        .run(nodeId)
    }
  }
}
```

注意：`checkOfflineNodes` 是同步方法（不能改为 async，因为被 `setInterval` 调用），所以对 logger 的调用使用 `void this.#logger.warn(...)` 忽略 Promise。

- [ ] **Step 3: 运行测试**

Run: `cd apps/controlplane && pnpm test -- src/services/__tests__/observation-monitor.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add apps/controlplane/src/services/observation-monitor.ts apps/controlplane/src/services/__tests__/observation-monitor.test.ts
git commit -m "feat(controlplane): 离线检测添加结构化日志"
```

---

### Task 8: 更新 server.ts 和 app.ts 入口

**Files:**
- Modify: `apps/controlplane/src/server.ts`
- Modify: `apps/controlplane/src/app.ts`
- Modify: `apps/controlplane/src/__tests__/app.test.ts`

- [ ] **Step 1: 更新 server.ts**

修改 `apps/controlplane/src/server.ts`，创建 logger 实例，替换 `console.log`：

```typescript
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { serve } from '@hono/node-server'
import { createJsonlFileSink, createObserverLogger, createStdoutSink } from '@tianji/observer'

import { createApp } from './app.js'
import { createDatabase } from './db/index.js'

const port = Number(process.env.TIANJI_CP_PORT ?? 3000)
const host = process.env.TIANJI_CP_HOST ?? '0.0.0.0'
const dataDir =
  process.env.TIANJI_CP_DATA_DIR ?? `${process.env.HOME}/.config/tianji-ai/controlplane`
const dbPath = `${dataDir}/controlplane.db`
const logFilePath = join(homedir(), '.config', 'tianji-ai', 'logs', 'tianji.log')

mkdirSync(dataDir, { recursive: true })

const db = createDatabase(dbPath)
const logger = createObserverLogger({
  sinks: [
    createJsonlFileSink({ filePath: logFilePath }),
    createStdoutSink({ pretty: true }),
  ],
})

const SCOPE_SERVER = ['controlplane', 'server'] as const

const { app, monitor } = createApp(db, logger)
monitor.start()

const server = serve({ fetch: app.fetch, port, hostname: host })

void logger.info(SCOPE_SERVER, 'Control plane started', { port, host, dbPath })

const shutdown = () => {
  monitor.stop()
  db.close()
  server.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

- [ ] **Step 2: 更新 app.ts**

按 Task 3 的内容修改 `apps/controlplane/src/app.ts`。

- [ ] **Step 3: 更新 app.test.ts 和其他集成测试**

读取 `apps/controlplane/src/__tests__/app.test.ts`、`apps/controlplane/src/__tests__/controlplane-node.e2e.test.ts` 等测试文件，将 `createApp(db)` 调用改为 `createApp(db, logger)`，其中 logger 使用 `createMemorySink` 构造。

- [ ] **Step 4: 运行全量测试**

Run: `cd apps/controlplane && pnpm test`
Expected: ALL PASS

- [ ] **Step 5: 运行 typecheck**

Run: `pnpm check`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add apps/controlplane/src/server.ts apps/controlplane/src/app.ts apps/controlplane/src/__tests__/
git commit -m "feat(controlplane): 接入 ObserverLogger 双 sink 日志系统"
```

---

### Task 9: 确认 ObserverMemorySink 类型导出

在 Task 4 和 Task 6 的测试中使用了 `ObserverMemorySink` 类型。需确认该类型是否已从 `@tianji/observer` 包级导出。

**Files:**
- Possibly modify: `packages/observer/src/index.ts`
- Possibly modify: `packages/observer/src/logger/index.ts`

- [ ] **Step 1: 检查导出**

确认 `packages/observer/src/index.ts` 是否导出了 `ObserverMemorySink`。若未导出，在 Task 1 的 Step 1 中一并补充：

```typescript
export type { ObserverMemorySink } from './logger/index.js'
```

并确认 `packages/observer/src/logger/index.ts` 导出了该类型：

```typescript
export type { ObserverMemorySink } from './sinks/memory.js'
```

- [ ] **Step 2: 运行 typecheck**

Run: `cd packages/observer && pnpm typecheck`
Expected: PASS

此 Task 应在 Task 1 中合并执行，列出仅为提醒。

---

## 日志级别总览

| 级别 | 场景 | 说明 |
|------|------|------|
| **debug** | 心跳接收、认证成功 | 高频常规操作，运维排查时开启 |
| **info** | 新节点注册、节点重新注册、服务启动 | 关键状态变更，默认可见 |
| **warn** | 无效 token、认证失败、Node ID 不匹配、节点离线、任务标记 observation_lost | 需要关注的异常 |
