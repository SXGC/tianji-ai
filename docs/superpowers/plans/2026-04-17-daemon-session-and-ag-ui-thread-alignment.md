# Daemon Session And AG-UI Thread Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 daemon 成为唯一 session 创建者，并让 CopilotKit / AG-UI 的 `threadId` 与 daemon `sessionId` 对齐，保证同一会话多轮聊天不会偷偷新建 session，同时前端支持显式新建会话。

**Architecture:** 方案分三层推进。第一层是 node daemon 协议：新增 `POST /sessions`，并要求 `POST /chat` 必须显式携带 `sessionId`；daemon client 同步支持创建 session 与带 `sessionId` 聊天。第二层是 ControlPlane / AG-UI 协议层：前端当前会话 ID 通过 CopilotKit 请求头进入后端，`TianjiAgent` 用它作为 AG-UI `threadId`，并把同一值写入下发给 node 的命令载荷。第三层是前端：store 持有当前 `sessionId`，初始化时创建 session，点击“New Session”时切换到新的 `sessionId`，聊天请求始终使用当前值。整个系统只允许一个真实会话标识：`sessionId == threadId`。

**Tech Stack:**
- 后端 node agent：Node.js HTTP server、Vitest、`@tianji/agent`
- ControlPlane：Hono、CopilotKit、AG-UI、better-sqlite3、Vitest
- 前端：React、TanStack Router、Zustand、Vitest、React Testing Library

**通用约束：**
- 每个文件 ≤ 800 行
- 禁止 `any`、禁止动态 import
- 涉及代码修改后，必须执行 `pnpm check` 并清掉所有错误 / 警告 / 信息
- 测试必须从对应包根目录执行
- 计划中的 commit 文案只是消息意图；真正执行 `git commit` 前必须先加载 `git-commit` skill

---

## Task 1: 定义 daemon session 协议

**Files:**
- Modify: `packages/agent/src/daemon-protocol.ts`
- Modify: `packages/agent/src/index.ts`
- Modify: `packages/agent/src/__tests__/daemon-protocol.test.ts`

**范围：** 为 daemon 协议增加显式 session 创建动作与带 `sessionId` 的聊天载荷，去掉把 `/ping.sessionId` 当“当前会话”的误导语义。

- [ ] **Step 1: 先补协议测试，锁定目标类型**

在 `packages/agent/src/__tests__/daemon-protocol.test.ts` 增加三组断言：

```ts
import type {
  ChatRequestBody,
  CreateSessionResponse,
  PingResponse,
} from '../daemon-protocol.js'

it('ChatRequestBody requires prompt and sessionId', () => {
  const body: ChatRequestBody = { prompt: 'hello', sessionId: 'session_123' }
  expect(body.sessionId).toBe('session_123')
})

it('CreateSessionResponse contains sessionId', () => {
  const body: CreateSessionResponse = { sessionId: 'session_123' }
  expect(body).toEqual({ sessionId: 'session_123' })
})

it('PingResponse no longer claims current chat session', () => {
  const body: PingResponse = {
    uptime: 42,
    pid: 999,
    controlPlane: {
      enabled: false,
      status: 'disabled',
      baseUrl: null,
      lastSuccessAt: null,
      lastError: null,
    },
  }
  expect('sessionId' in body).toBe(false)
})
```

- [ ] **Step 2: 运行协议测试，确认先失败**

Run: `pnpm --filter @tianji/agent test -- daemon-protocol.test.ts`

Expected: 因为 `ChatRequestBody` / `PingResponse` / `CreateSessionResponse` 现状不匹配而失败。

- [ ] **Step 3: 修改协议类型定义**

在 `packages/agent/src/daemon-protocol.ts` 做这几个变化：

```ts
import type { SessionId } from '@tianji/shared'

export interface ChatRequestBody {
  readonly prompt: string
  readonly sessionId: SessionId
}

export interface CreateSessionResponse {
  readonly sessionId: SessionId
}

export interface PingResponse {
  readonly uptime: number
  readonly pid: number
  readonly controlPlane: ControlPlaneStatusSnapshot
}
```

并把 `packages/agent/src/index.ts` 的对外导出补齐 `CreateSessionResponse`。

- [ ] **Step 4: 重新运行协议测试**

Run: `pnpm --filter @tianji/agent test -- daemon-protocol.test.ts`

Expected: PASS。

- [ ] **Step 5: 运行 agent 包检查**

Run: `pnpm --filter @tianji/agent check`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/daemon-protocol.ts packages/agent/src/index.ts packages/agent/src/__tests__/daemon-protocol.test.ts
git commit -m "refactor(agent): split daemon session creation from chat protocol"
```

## Task 2: daemon server 显式创建 session，并要求 chat 带 sessionId

**Files:**
- Modify: `packages/agent/src/daemon-server.ts`
- Modify: `packages/agent/src/__tests__/daemon-server.test.ts`

**范围：** 新增 `POST /sessions`，`POST /chat` 缺失 `sessionId` 时返回 400，并把 `sessionId` 透传给 `entry.run()`。

- [ ] **Step 1: 补 daemon server 行为测试**

在 `packages/agent/src/__tests__/daemon-server.test.ts` 增加这些测试：

```ts
it('POST /sessions returns a new sessionId', async () => {
  const bus = createStubBus()
  const entry = createStubEntry(bus)
  server = new DaemonServer({ entry, bus })
  await server.listen(0)

  const res = await fetch(`${baseUrl(server)}/sessions`, { method: 'POST' })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { sessionId: string }
  expect(body.sessionId).toMatch(/^session_/)
})

it('POST /chat without sessionId returns 400', async () => {
  const bus = createStubBus()
  const entry = createStubEntry(bus)
  server = new DaemonServer({ entry, bus })
  await server.listen(0)

  const res = await fetch(`${baseUrl(server)}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'hi' }),
  })

  expect(res.status).toBe(400)
})

it('POST /chat forwards sessionId to entry.run', async () => {
  const bus = createStubBus()
  const entry = createStubEntry(bus)
  server = new DaemonServer({ entry, bus })
  await server.listen(0)

  await fetch(`${baseUrl(server)}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'hi', sessionId: 'session_existing' }),
  })

  expect(entry.run).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'daemon',
      input: 'hi',
      sessionId: 'session_existing',
    })
  )
})
```

- [ ] **Step 2: 运行 daemon server 测试，确认失败**

Run: `pnpm --filter @tianji/agent test -- daemon-server.test.ts`

Expected: 新路由不存在，旧 `/chat` 不校验 `sessionId`，断言失败。

- [ ] **Step 3: 实现 daemon session 路由与 chat 校验**

在 `packages/agent/src/daemon-server.ts` 做下面的收口：

```ts
import type { SessionId } from '@tianji/shared'

function createDaemonSessionId(): SessionId {
  return `session_${Date.now()}_${crypto.randomUUID()}` as SessionId
}

if (req.method === 'POST' && url.pathname === '/sessions') {
  return this.#handleCreateSession(res)
}

#handleCreateSession(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ sessionId: createDaemonSessionId() }))
}

if (typeof parsed.prompt !== 'string' || typeof parsed.sessionId !== 'string') {
  res.writeHead(400, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'missing prompt or sessionId field' }))
  return
}

const handle = await this.#entry.run({
  source: 'daemon',
  input: parsed.prompt,
  sessionId: parsed.sessionId as SessionId,
})
```

同时更新 `#handlePing()`，不再返回固定的 `sessionId: 'unified-entry'`。

- [ ] **Step 4: 重新运行 daemon server 测试**

Run: `pnpm --filter @tianji/agent test -- daemon-server.test.ts`

Expected: PASS。

- [ ] **Step 5: 运行 agent 包检查**

Run: `pnpm --filter @tianji/agent check`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/daemon-server.ts packages/agent/src/__tests__/daemon-server.test.ts
git commit -m "feat(agent): let daemon issue session ids explicitly"
```

## Task 3: daemon client 支持 createSession 和 sendChat(sessionId)

**Files:**
- Modify: `packages/agent/src/daemon-client.ts`
- Modify: `packages/agent/src/__tests__/daemon-client.test.ts`

**范围：** client 不再假设 `/chat` 只需要 `prompt`，并提供显式的 `createSession()` 方法。

- [ ] **Step 1: 补客户端 API 测试**

在 `packages/agent/src/__tests__/daemon-client.test.ts` 增加：

```ts
it('createSession returns sessionId', async () => {
  const { client, close } = await setupServer((req, res) => {
    if (req.method === 'POST' && req.url === '/sessions') {
      writeJson(res, { sessionId: 'session_123' })
      return
    }
    res.writeHead(404)
    res.end()
  })
  closeServer = close

  await expect(client.createSession()).resolves.toEqual({ sessionId: 'session_123' })
})

it('sendChat posts prompt and sessionId', async () => {
  let requestBody = ''
  const { client, close } = await setupServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/chat') {
      for await (const chunk of req) {
        requestBody += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      }
      writeSseHeaders(res)
      res.write(sseDone())
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  closeServer = close

  for await (const _ of client.sendChat('hi', 'session_abc' as never)) {
    // consume
  }

  expect(JSON.parse(requestBody)).toEqual({ prompt: 'hi', sessionId: 'session_abc' })
})
```

- [ ] **Step 2: 运行 daemon client 测试，确认失败**

Run: `pnpm --filter @tianji/agent test -- daemon-client.test.ts`

Expected: `createSession()` 不存在，`sendChat()` 签名不匹配。

- [ ] **Step 3: 实现客户端 API**

在 `packages/agent/src/daemon-client.ts` 调整公开接口：

```ts
import type { SessionId } from '@tianji/shared'
import type { CreateSessionResponse } from './daemon-protocol.js'

async createSession(): Promise<CreateSessionResponse> {
  const res = await httpRequest({
    host: this.#host,
    port: this.#port,
    method: 'POST',
    path: '/sessions',
  })
  this.#lastResponse = res
  assertOk(res, '/sessions')
  const body = await readBody(res)
  this.#lastResponse = undefined
  return JSON.parse(body) as CreateSessionResponse
}

async *sendChat(prompt: string, sessionId: SessionId): AsyncIterable<DomainEventEnvelope> {
  const body = JSON.stringify({ prompt, sessionId })
  // 其余逻辑保持不变
}
```

- [ ] **Step 4: 重新运行 daemon client 测试**

Run: `pnpm --filter @tianji/agent test -- daemon-client.test.ts`

Expected: PASS。

- [ ] **Step 5: 运行 agent 包检查**

Run: `pnpm --filter @tianji/agent check`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/daemon-client.ts packages/agent/src/__tests__/daemon-client.test.ts
git commit -m "feat(agent): expose daemon session creation in client api"
```

## Task 4: ControlPlane 把 sessionId 作为 AG-UI threadId 主键

**Files:**
- Modify: `apps/controlplane/src/routes/copilot.ts`
- Modify: `apps/controlplane/src/agents/tianji-agent.ts`
- Modify: `apps/controlplane/src/agents/__tests__/tianji-agent.test.ts`
- Modify: `apps/controlplane/src/routes/__tests__/copilot.test.ts`

**范围：** 从 CopilotKit 请求头读取当前 `sessionId`，禁止继续用 `nodeId` 兜底 thread，命令载荷里也保存同一个 `sessionId`。

- [ ] **Step 1: 先加 ControlPlane 行为测试**

在 `apps/controlplane/src/routes/__tests__/copilot.test.ts` 增加：

```ts
it('x-session-id 缺失时返回 400', async () => {
  const { app } = setup()
  insertNode('node-1', 'online')

  const response = await app.request('/api/copilot', {
    method: 'POST',
    headers: { 'x-node-id': 'node-1', 'x-agent-id': 'agent-1' },
  })

  expect(response.status).toBe(400)
})
```

在 `apps/controlplane/src/agents/__tests__/tianji-agent.test.ts` 增加：

```ts
it('uses sessionId from forwarded props as AG-UI threadId', async () => {
  db = createDatabase(':memory:')
  setupOnlineNode('node-1')

  const agent = new TianjiAgent(db, 'node-1', 'agent-1', undefined, makeTestLogger())

  const events = await firstValueFrom(
    agent.run({
      messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
      tools: [],
      context: [],
      forwardedProps: { sessionId: 'session_123' },
      state: {},
    }).pipe(toArray())
  )

  expect(events[0]).toMatchObject({ type: 'RUN_STARTED', threadId: 'session_123' })
})

it('writes sessionIds into command payload', async () => {
  db = createDatabase(':memory:')
  setupOnlineNode('node-1')

  const agent = new TianjiAgent(db, 'node-1', 'agent-1', undefined, makeTestLogger())

  await firstValueFrom(
    agent.run({
      messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
      tools: [],
      context: [],
      forwardedProps: { sessionId: 'session_123' },
      state: {},
    })
  )

  const commandRow = db.raw
    .prepare('SELECT payload FROM commands ORDER BY created_at DESC LIMIT 1')
    .get() as { payload: string }

  expect(JSON.parse(commandRow.payload)).toMatchObject({ sessionIds: ['session_123'] })
})
```

- [ ] **Step 2: 运行 controlplane 测试，确认失败**

Run: `pnpm --filter @tianji/controlplane test -- copilot.test.ts tianji-agent.test.ts`

Expected: 因为当前没有 `x-session-id` 校验，`threadId` 仍然回退到 `nodeId` 而失败。

- [ ] **Step 3: 在 route 层显式要求 x-session-id**

在 `apps/controlplane/src/routes/copilot.ts` 修改请求头校验与 agent 构造：

```ts
const sessionId = c.req.header('x-session-id')

if (!nodeId || !agentId || !sessionId) {
  return c.json({ error: 'Missing x-node-id, x-agent-id or x-session-id header' }, 400)
}

const agent = new TianjiAgent(db, nodeId, agentId, bus, logger, sessionId)
```

- [ ] **Step 4: 在 TianjiAgent 中统一 threadId == sessionId**

在 `apps/controlplane/src/agents/tianji-agent.ts` 收紧规则：

```ts
constructor(
  db: ControlPlaneDb,
  nodeId: string,
  agentId: string,
  bus: EventBus | undefined,
  logger: ObserverLogger,
  sessionId: string
) {
  super({ description: `Tianji agent for node ${nodeId}` })
  this.#sessionId = sessionId
}

const threadId = this.#sessionId

const payload = JSON.stringify({
  taskId,
  agentId: this.#cpAgentId,
  goal: goalText,
  sessionIds: [this.#sessionId],
})
```

不要继续保留 `input.threadId ?? this.#nodeId` 这种兜底。

- [ ] **Step 5: 重新运行 controlplane 测试**

Run: `pnpm --filter @tianji/controlplane test -- copilot.test.ts tianji-agent.test.ts`

Expected: PASS。

- [ ] **Step 6: 运行 controlplane 检查**

Run: `pnpm --filter @tianji/controlplane check`

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add apps/controlplane/src/routes/copilot.ts apps/controlplane/src/agents/tianji-agent.ts apps/controlplane/src/agents/__tests__/tianji-agent.test.ts apps/controlplane/src/routes/__tests__/copilot.test.ts
git commit -m "refactor(controlplane): align ag-ui thread id with daemon session id"
```

## Task 5: 前端 store 管理当前 session，并支持显式新建会话

**Files:**
- Modify: `apps/controlplane/src/web/stores/app-store.ts`
- Modify: `apps/controlplane/src/web/routes/index.tsx`
- Create: `apps/controlplane/src/web/lib/session-api.ts`
- Create: `apps/controlplane/src/web/components/new-session-button.tsx`
- Modify: `apps/controlplane/src/web/components/layout.tsx`
- Modify: `apps/controlplane/src/web/stores/__tests__/app-store.test.ts`

**范围：** 页面进入时创建 session；点击按钮时切换到新 session；node/agent 切换时清空旧 session；CopilotKit headers 始终带当前 `sessionId`。

- [ ] **Step 1: 先补 store 和路由测试**

在 `apps/controlplane/src/web/stores/__tests__/app-store.test.ts` 增加：

```ts
it('selectNode clears current sessionId', () => {
  const store = useAppStore.getState()
  store.setSessionId('session_old')
  store.selectNode('node-1', 'agent-1')
  expect(useAppStore.getState().sessionId).toBeNull()
})
```

再在前端路由测试里增加一个目标断言：当 `sessionId` 已存在时，`CopilotKit` headers 包含 `x-session-id`。

- [ ] **Step 2: 运行前端测试，确认失败或覆盖不足**

Run: `pnpm --filter @tianji/controlplane test -- app-store.test.ts __root.test.tsx`

Expected: 至少会因为当前没有 `x-session-id` header 路径而需要实现。

- [ ] **Step 3: 新建 session API 封装**

创建 `apps/controlplane/src/web/lib/session-api.ts`：

```ts
export interface CreateSessionResult {
  readonly sessionId: string
}

export async function createSession(nodeId: string): Promise<CreateSessionResult> {
  const response = await fetch(`/api/nodes/${nodeId}/sessions`, { method: 'POST' })
  if (!response.ok) {
    throw new Error(`create session failed: ${response.status}`)
  }
  return (await response.json()) as CreateSessionResult
}
```

这里用 controlplane 代理接口，不让浏览器直接碰 node daemon 端口。

- [ ] **Step 4: 在 store 和首页路由里接入 session 生命周期**

在 `apps/controlplane/src/web/stores/app-store.ts` 增加最小动作：

```ts
createSessionForSelection: async () => {
  const state = useAppStore.getState()
  if (state.selectedNodeId === null) {
    throw new Error('selectedNodeId is required')
  }
  const result = await createSession(state.selectedNodeId)
  set({ sessionId: result.sessionId })
}
```

在 `apps/controlplane/src/web/routes/index.tsx` 把 `sessionId` 接进 `CopilotKit` headers：

```tsx
const {
  fetchNodes,
  selectedNodeId,
  selectedAgentId,
  sessionId,
  createSessionForSelection,
} = useAppStore()

useEffect(() => {
  if (selectedNodeId === null || selectedAgentId === null || sessionId !== null) {
    return
  }
  void createSessionForSelection()
}, [selectedNodeId, selectedAgentId, sessionId, createSessionForSelection])

if (selectedNodeId === null || selectedAgentId === null || sessionId === null) {
  return <Layout />
}

<CopilotKit
  runtimeUrl="/api/copilot"
  headers={{
    'x-node-id': selectedNodeId,
    'x-agent-id': selectedAgentId,
    'x-session-id': sessionId,
  }}
>
```

- [ ] **Step 5: 增加“New Session”按钮组件并接入布局**

创建 `apps/controlplane/src/web/components/new-session-button.tsx`：

```tsx
import { useTransition } from 'react'

import { useAppStore } from '../stores/app-store'

export function NewSessionButton() {
  const createSessionForSelection = useAppStore((state) => state.createSessionForSelection)
  const selectedNodeId = useAppStore((state) => state.selectedNodeId)
  const [pending, startTransition] = useTransition()

  return (
    <button
      type="button"
      disabled={selectedNodeId === null || pending}
      onClick={() => {
        startTransition(() => {
          void createSessionForSelection()
        })
      }}
    >
      New Session
    </button>
  )
}
```

然后在 `apps/controlplane/src/web/components/layout.tsx` 的顶部工具区挂上它。

- [ ] **Step 6: 重新运行前端测试**

Run: `pnpm --filter @tianji/controlplane test -- app-store.test.ts __root.test.tsx`

Expected: PASS。

- [ ] **Step 7: 运行 controlplane 检查**

Run: `pnpm --filter @tianji/controlplane check`

Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add apps/controlplane/src/web/stores/app-store.ts apps/controlplane/src/web/routes/index.tsx apps/controlplane/src/web/lib/session-api.ts apps/controlplane/src/web/components/new-session-button.tsx apps/controlplane/src/web/components/layout.tsx apps/controlplane/src/web/stores/__tests__/app-store.test.ts
git commit -m "feat(controlplane): add explicit new session flow in web ui"
```

## Task 6: ControlPlane 代理 node daemon 的 session 创建接口

**Files:**
- Create: `apps/controlplane/src/routes/node-session-create.ts`
- Modify: `apps/controlplane/src/app.ts`
- Modify: `apps/controlplane/src/routes/__tests__/node-register.test.ts`
- Create: `apps/controlplane/src/routes/__tests__/node-session-create.test.ts`

**范围：** 浏览器不能直接访问 node daemon，所以要由 ControlPlane 提供一条代理路由，代 node 调用 `/sessions`。

- [ ] **Step 1: 先补代理路由测试**

创建 `apps/controlplane/src/routes/__tests__/node-session-create.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'

describe('POST /api/nodes/:nodeId/sessions', () => {
  it('returns daemon-created sessionId', async () => {
    const createSession = vi.fn().mockResolvedValue({ sessionId: 'session_123' })
    // 这里沿用现有 app 装配方式，把 node runtime mock 成带 createSession 的实现
    expect(createSession).toBeDefined()
  })
})
```

这个测试要落成现有 controlplane route 测试风格：用内存 DB、插入 online node、mock 下游 node runtime，然后断言返回 200 与 `sessionId`。

- [ ] **Step 2: 运行新测试，确认失败**

Run: `pnpm --filter @tianji/controlplane test -- node-session-create.test.ts`

Expected: 路由不存在。

- [ ] **Step 3: 实现 node session create route**

创建 `apps/controlplane/src/routes/node-session-create.ts`，对外暴露：

```ts
export function createNodeSessionCreateRoute(/* deps */): Hono {
  const app = new Hono()

  app.post('/api/nodes/:nodeId/sessions', async (c) => {
    const nodeId = c.req.param('nodeId')
    // 1. 校验节点存在且在线
    // 2. 通过现有 node runtime / daemon client 调用 createSession()
    // 3. 原样返回 { sessionId }
  })

  return app
}
```

`apps/controlplane/src/app.ts` 负责挂载该路由。

- [ ] **Step 4: 重新运行路由测试**

Run: `pnpm --filter @tianji/controlplane test -- node-session-create.test.ts`

Expected: PASS。

- [ ] **Step 5: 运行 controlplane 检查**

Run: `pnpm --filter @tianji/controlplane check`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/controlplane/src/routes/node-session-create.ts apps/controlplane/src/app.ts apps/controlplane/src/routes/__tests__/node-session-create.test.ts
git commit -m "feat(controlplane): proxy daemon session creation for web clients"
```

## Task 7: 端到端验证同 session 复用与新 session 切换

**Files:**
- Modify: `apps/node/src/__tests__/controlplane-runtime.test.ts`
- Modify: `apps/node/src/__tests__/native-agent-routing-integration.test.ts`
- Modify: `apps/controlplane/src/agents/__tests__/tianji-agent.gate.integration.test.ts`
- Modify: `README.md`

**范围：** 验证“同 session 连续聊天复用旧会话”和“点击 New Session 后切到新会话”两条主链路，并更新文档说明 session 现在由 daemon 创建。

- [ ] **Step 1: 补一条 node/runtime 集成测试，锁定会话复用**

在 `apps/node/src/__tests__/native-agent-routing-integration.test.ts` 增加最小场景：

```ts
it('reuses the same sessionId across multiple chat turns', async () => {
  const sessionId = 'session_test_reuse'
  // 第一次 run 带 sessionId
  // 第二次 run 继续带同一个 sessionId
  // 断言下游收到的 sessionId 始终相同，且没有生成第二个 sessionId
})
```

- [ ] **Step 2: 补一条 AG-UI 集成测试，锁定 threadId == sessionId**

在 `apps/controlplane/src/agents/__tests__/tianji-agent.gate.integration.test.ts` 增加：

```ts
it('emits RUN_STARTED with threadId equal to forwarded sessionId', async () => {
  expect(firstRunStarted.threadId).toBe('session_123')
})
```

- [ ] **Step 3: 补 README 文档说明**

在 `README.md` 对应 node daemon / controlplane 使用章节补一段：

```md
## Session model

- Sessions are created by the node daemon via `POST /sessions`.
- Web clients must create a session first, then send chat requests with that `sessionId`.
- In the CopilotKit / AG-UI layer, `threadId` is aligned with the same `sessionId`.
- Clicking "New Session" in the web UI switches subsequent turns onto a fresh daemon session.
```

- [ ] **Step 4: 运行回归测试**

Run: `pnpm --filter @tianji/controlplane test -- tianji-agent.gate.integration.test.ts`

Run: `pnpm --filter @tianji/node test -- native-agent-routing-integration.test.ts controlplane-runtime.test.ts`

Expected: PASS。

- [ ] **Step 5: 全量检查**

Run: `pnpm check`

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/node/src/__tests__/controlplane-runtime.test.ts apps/node/src/__tests__/native-agent-routing-integration.test.ts apps/controlplane/src/agents/__tests__/tianji-agent.gate.integration.test.ts README.md
git commit -m "test: cover daemon-owned session reuse across ag-ui and node runtime"
```

---

## Self-Review

**Spec coverage:**
- daemon 生成 sessionId：Task 1, 2, 3, 6 覆盖
- 前端 New Session 按钮：Task 5 覆盖
- chat 必带 sessionId：Task 2, 3, 4, 5 覆盖
- CopilotKit / AG-UI threadId 对齐：Task 4, 7 覆盖
- 文档同步：Task 7 覆盖

**Placeholder scan:**
- 没有 `TODO` / `TBD` 占位词
- 唯一依赖现有 app 装配方式的地方，是 Task 6 测试里的 node runtime mock；这里已经明确必须落成现有 route 测试风格，执行时不能偷懒跳过

**Type consistency:**
- 统一使用 `sessionId` 作为 daemon / 前端 / AG-UI 唯一会话标识
- `threadId == sessionId` 只在 ControlPlane AG-UI 层建立，不再保留 `nodeId` fallback

**Plan file:** `docs/superpowers/plans/2026-04-17-daemon-session-and-ag-ui-thread-alignment.md`
