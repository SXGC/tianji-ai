# Controlplane Web UI 重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 controlplane web UI 从自定义 SSE + React Query 架构重构为 CopilotKit + Zustand + AG-UI 协议架构，保持现有最简功能不变。

**Architecture:** 后端新增 TianjiAgent（AG-UI 适配器）+ CopilotRuntime Hono 路由，将现有 task_events 翻译为 AG-UI 事件流。前端用 Zustand 管理节点/选中状态，CopilotKit 管理聊天交互，三栏布局（节点列表 + 工作区预留 + 聊天区）。旧的 UI 端点全部删除。

**Tech Stack:** React 19, Zustand, CopilotKit (@copilotkit/runtime + @copilotkit/react-core + @copilotkit/react-ui), @ag-ui/client, Hono, TanStack Router, Vite

**Spec:** `docs/superpowers/specs/2026-04-10-controlplane-web-ui-redesign.md`

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 新增 | `src/agents/event-mapper.ts` | 纯函数：task_event → AG-UI BaseEvent 翻译 |
| 新增 | `src/agents/tianji-agent.ts` | AG-UI 兼容 agent 适配器，桥接 task/event 服务 |
| 新增 | `src/routes/copilot.ts` | CopilotRuntime Hono 路由 |
| 新增 | `src/agents/__tests__/event-mapper.test.ts` | event-mapper 单元测试 |
| 新增 | `src/routes/__tests__/copilot.test.ts` | copilot 路由集成测试 |
| 新增 | `src/web/stores/app-store.ts` | Zustand store |
| 新增 | `src/web/stores/__tests__/app-store.test.ts` | store 单元测试 |
| 新增 | `src/web/lib/nodes-api.ts` | fetchNodes API 函数 |
| 新增 | `src/web/components/layout.tsx` | 三栏布局容器 |
| 新增 | `src/web/components/workspace-panel.tsx` | 工作区空面板 |
| 改造 | `src/app.ts` | 删除旧路由注册，新增 copilot 路由 |
| 改造 | `src/web/main.tsx` | 移除 QueryClientProvider，简化为 RouterProvider |
| 改造 | `src/web/routes/index.tsx` | 大幅简化，用 Layout + CopilotKit |
| 改造 | `src/web/components/node-list.tsx` | 数据源改为 Zustand |
| 改造 | `package.json` | 新增/移除依赖 |
| 重写 | `src/web/styles.css` | 全部重写为新视觉风格 |
| 删除 | `src/routes/ui-tasks.ts` | 被 CopilotRuntime 替代 |
| 删除 | `src/routes/task-stream.ts` | 被 AG-UI SSE 替代 |
| 删除 | `src/routes/ui-sessions.ts` | 前端不再直接管 session |
| 删除 | `src/routes/ui-task-events.ts` | 前端不再直接查事件 |
| 删除 | `src/web/lib/api.ts` | fetchNodes 迁移到 nodes-api.ts |
| 删除 | `src/web/lib/task-stream.ts` | SSE 由 CopilotKit 处理 |
| 删除 | `src/web/lib/query-client.ts` | React Query 移除 |
| 删除 | `src/web/components/chat-shell.tsx` | 被 layout.tsx 替代 |
| 删除 | `src/web/components/chat-composer.tsx` | 被 CopilotChat 替代 |
| 删除 | `src/web/components/message-list.tsx` | 被 CopilotChat 替代 |
| 删除 | `src/web/lib/__tests__/task-stream.test.ts` | 对应源文件已删 |

---

## Task 1: 安装依赖

**Files:**
- Modify: `apps/controlplane/package.json`

- [ ] **Step 1: 安装新依赖，移除旧依赖**

```bash
cd /workspaces/dev_docker/tianji-ai
pnpm --filter @tianji/controlplane add zustand @copilotkit/react-core @copilotkit/react-ui @copilotkit/runtime @ag-ui/client
pnpm --filter @tianji/controlplane remove @tanstack/react-query
```

- [ ] **Step 2: 验证安装**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm --filter @tianji/controlplane exec -- node -e "require.resolve('@copilotkit/runtime')"`

Expected: 输出路径，无报错。

- [ ] **Step 3: 确认 @ag-ui/client 导出 AbstractAgent**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm --filter @tianji/controlplane exec -- node -e "const m = require('@ag-ui/client'); console.log(typeof m.AbstractAgent)"`

Expected: 输出 `function`。如果不是，需要查找正确的导出名，并在后续 Task 中相应调整。将实际的类名记录下来。

- [ ] **Step 4: 确认 @copilotkit/runtime 导出 createCopilotEndpointHono**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm --filter @tianji/controlplane exec -- node -e "const m = require('@copilotkit/runtime'); console.log(typeof m.createCopilotEndpointHono); if (!m.createCopilotEndpointHono) { const hono = require('@copilotkit/runtime/hono'); console.log('hono subpath:', Object.keys(hono)) }"`

Expected: 输出 `function`。如果不存在，检查是否在子路径 `@copilotkit/runtime/hono` 下导出。将实际的导入路径记录下来。

- [ ] **Step 5: Commit**

```bash
cd /workspaces/dev_docker/tianji-ai
git add apps/controlplane/package.json pnpm-lock.yaml
```

使用 git-commit skill 提交。

---

## Task 2: 事件映射器（纯函数 + 测试）

这是整个重构的核心逻辑单元，必须先写测试再实现。event-mapper 是纯函数，不依赖任何外部服务，只做 task_event → AG-UI event 的翻译。

**Files:**
- Create: `apps/controlplane/src/agents/event-mapper.ts`
- Create: `apps/controlplane/src/agents/__tests__/event-mapper.test.ts`

**参考文档:**
- Spec 4.4 事件映射表（`docs/superpowers/specs/2026-04-10-controlplane-web-ui-redesign.md:127-229`）
- RuntimeEvent 类型定义（`packages/shared/src/events.ts`）
- TaskEvent 类型定义（`packages/shared/src/task-event.ts`）
- AG-UI 事件类型：安装后从 `@ag-ui/client` 中查看 `EventType` 枚举和 `BaseEvent` 类型

### Step 2a: 探索 AG-UI 事件类型

- [ ] **Step 1: 查看 @ag-ui/client 的实际导出类型**

```bash
cd /workspaces/dev_docker/tianji-ai
# 查找 EventType 枚举定义
grep -r "EventType" node_modules/@ag-ui/client/dist/ --include="*.d.ts" | head -30
# 查找 BaseEvent 类型定义
grep -r "BaseEvent" node_modules/@ag-ui/client/dist/ --include="*.d.ts" | head -30
```

记录实际的事件类型枚举值（如 `EventType.TEXT_MESSAGE_START` 等）和 BaseEvent 结构。后续代码中使用这些实际值。

### Step 2b: 写测试

- [ ] **Step 2: 编写 event-mapper 测试**

创建 `apps/controlplane/src/agents/__tests__/event-mapper.test.ts`。测试用例必须覆盖 spec 8.1 列出的所有测试点：

1. `task.started` lifecycle → `RUN_STARTED`
2. `task.completed` lifecycle → `RUN_FINISHED`
3. `task.failed` lifecycle → `RUN_ERROR`
4. `task.cancelled` lifecycle → `RUN_ERROR`
5. `task.session.attached` lifecycle → `STATE_DELTA` with JSON Patch `[{ op: 'replace', path: '/sessionId', value: '<id>' }]`
6. `task.waiting` lifecycle → `STATE_DELTA` with `[{ op: 'replace', path: '/taskStatus', value: 'waiting' }]`
7. `message.started` agent event → `TEXT_MESSAGE_START`
8. `message.delta` (channel='text') agent event → `TEXT_MESSAGE_CONTENT`
9. `message.delta` (channel='thinking') agent event → `REASONING_MESSAGE_CONTENT`（首次 thinking delta 前额外发 `REASONING_START` + `REASONING_MESSAGE_START`）
10. `message.completed` agent event → `TEXT_MESSAGE_END`（如果在 thinking 状态，先发 `REASONING_MESSAGE_END` + `REASONING_END`）
11. `tool.started` agent event → `TOOL_CALL_START` with `toolCallId`, `toolCallName`, `args`（完整参数，一次性）
12. `tool.completed` agent event → `TOOL_CALL_END` + `TOOL_CALL_RESULT`
13. `tool.failed` agent event → `TOOL_CALL_END` with error
14. `run.started` agent event → `STEP_STARTED` with `metadata.stepKind='run'`
15. `run.completed` agent event → `STEP_FINISHED` with `metadata.stepKind='run'`
16. `graph.started` agent event → `STEP_STARTED` with `metadata.stepKind='graph'`，含 `graphId`
17. `graph.node.started` agent event → `STEP_STARTED` with `metadata.stepKind='graph-node'`，含 `graphId`, `nodeId`, `nodeKind`
18. `graph.node.completed` agent event → `STEP_FINISHED` with `metadata.stepKind='graph-node'`

测试的输入是 `StoredTaskEvent`（来自 `src/services/event-store.ts:3-9`），payload 是 JSON 字符串。lifecycle 事件的 payload 是 `TaskLifecycleEvent` 序列化，agent 事件的 payload 是 `TaskAgentEvent` 序列化。

每个测试用例的结构：构造一个 `StoredTaskEvent` 输入 → 调用 `mapTaskEventToAgUiEvents(event, context)` → 断言输出的 AG-UI 事件数组。

`context` 是一个可变对象，用于跟踪 thinking 状态：
```typescript
interface EventMapperContext {
  inThinking: boolean
  taskId: string
}
```

- [ ] **Step 3: 运行测试确认全部失败**

Run: `cd /workspaces/dev_docker/tianji-ai/apps/controlplane && pnpm vitest run src/agents/__tests__/event-mapper.test.ts`

Expected: 全部 FAIL（函数未实现）。

### Step 2c: 实现

- [ ] **Step 4: 实现 event-mapper.ts**

创建 `apps/controlplane/src/agents/event-mapper.ts`。

核心导出：

```typescript
import type { StoredTaskEvent } from '../services/event-store.js'
// 从 @ag-ui/client 导入实际的事件类型（根据 Step 1 探索结果调整）

export interface EventMapperContext {
  inThinking: boolean
  taskId: string
}

/**
 * 将单个 StoredTaskEvent 翻译为一个或多个 AG-UI 事件。
 *
 * 纯函数 + context 副作用（仅 inThinking 状态追踪）。
 * 一个输入事件可能产生多个输出事件（如首次 thinking delta 需要先发 REASONING_START）。
 */
export function mapTaskEventToAgUiEvents(
  event: StoredTaskEvent,
  ctx: EventMapperContext
): BaseEvent[] {
  // ...
}

/**
 * 生成初始 STATE_SNAPSHOT 事件。
 */
export function createInitialStateSnapshot(): BaseEvent {
  // 返回 STATE_SNAPSHOT: { sessionId: null, taskStatus: null, taskId: null }
}
```

实现逻辑：
1. 解析 `event.payload` JSON
2. 根据 `event.kind` 分发：
   - `kind === 'lifecycle'`：解析 payload 中的 `type` 字段，按 spec 4.4.1 和 4.4.6 映射
   - `kind === 'agent'`：解析 payload 中的 `event` 字段（RuntimeEvent），按 spec 4.4.2-4.4.5 映射
3. thinking 状态追踪：用 `ctx.inThinking` 标记是否处于 thinking 通道
4. 返回事件数组

- [ ] **Step 5: 运行测试确认全部通过**

Run: `cd /workspaces/dev_docker/tianji-ai/apps/controlplane && pnpm vitest run src/agents/__tests__/event-mapper.test.ts`

Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
cd /workspaces/dev_docker/tianji-ai
git add apps/controlplane/src/agents/event-mapper.ts apps/controlplane/src/agents/__tests__/event-mapper.test.ts
```

使用 git-commit skill 提交。

---

## Task 3: TianjiAgent 适配器

**Files:**
- Create: `apps/controlplane/src/agents/tianji-agent.ts`

**依赖:** Task 2（event-mapper）

**参考文档:**
- Spec 4.3 TianjiAgent（`docs/superpowers/specs/2026-04-10-controlplane-web-ui-redesign.md:107-125`）
- `@ag-ui/client` 的 `AbstractAgent` 基类 API（根据 Task 1 Step 3 的探索结果）
- EventStore（`apps/controlplane/src/services/event-store.ts`）
- ui-tasks.ts 中的 task 创建逻辑（`apps/controlplane/src/routes/ui-tasks.ts:42-93`）——需要将其中的 SQL 逻辑提取复用
- task-stream.ts 中的轮询逻辑（`apps/controlplane/src/routes/task-stream.ts:29-65`）——需要复用其轮询模式

- [ ] **Step 1: 实现 TianjiAgent**

创建 `apps/controlplane/src/agents/tianji-agent.ts`。

这个类需要：
1. 继承/实现 `@ag-ui/client` 的 `AbstractAgent`（具体基类以 Task 1 探索结果为准）
2. 构造函数接收 `ControlPlaneDb` + `nodeId` + `agentId`
3. 实现 agent 的执行方法（`run`/`execute`/`stream`，以实际 API 为准），返回 AG-UI 事件流（Observable 或 AsyncIterable）
4. 执行方法内部逻辑：
   a. 从消息中提取最后一条 user message 作为 goal
   b. 校验节点存在性和在线状态（复用 ui-tasks.ts:45-54 的 SQL）
   c. 创建 task + command（复用 ui-tasks.ts:71-91 的 SQL）
   d. 发送 `STATE_SNAPSHOT`（初始状态）
   e. 发送 `STATE_DELTA`（taskStatus: 'running', taskId）
   f. 轮询 EventStore.getEvents（复用 task-stream.ts:29-65 的轮询模式，500ms 间隔）
   g. 对每个 event 调用 `mapTaskEventToAgUiEvents` 翻译并发送
   h. task 进入终态且无更多事件时，检查是否有 message 事件，无则发送兜底 TEXT_MESSAGE
   i. 发送 `RUN_FINISHED` 并结束流

注意：不要把 ui-tasks.ts 的 SQL 复制一份。而是把 task 创建逻辑提取为一个 service 函数（如 `src/services/task-service.ts`），让 TianjiAgent 调用它。但这是一个小的重构，如果提取 service 会导致改动过多，可以直接内联 SQL（因为旧的 ui-tasks.ts 要删掉）。

- [ ] **Step 2: 编译检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm --filter @tianji/controlplane exec -- tsc --noEmit --project tsconfig.json`

Expected: 无类型错误。如果有，修复。

- [ ] **Step 3: Commit**

```bash
cd /workspaces/dev_docker/tianji-ai
git add apps/controlplane/src/agents/tianji-agent.ts
```

使用 git-commit skill 提交。

---

## Task 4: CopilotRuntime Hono 路由 + 集成测试

**Files:**
- Create: `apps/controlplane/src/routes/copilot.ts`
- Create: `apps/controlplane/src/routes/__tests__/copilot.test.ts`

**依赖:** Task 3（TianjiAgent）

**参考文档:**
- CopilotKit Hono 集成示例：`createCopilotEndpointHono({ runtime })` 或等效 API
- Spec 4.2（`docs/superpowers/specs/2026-04-10-controlplane-web-ui-redesign.md:94-105`）
- Spec 5.4 后端校验规则（`docs/superpowers/specs/2026-04-10-controlplane-web-ui-redesign.md:338-342`）

### Step 4a: 写测试

- [ ] **Step 1: 编写路由集成测试**

创建 `apps/controlplane/src/routes/__tests__/copilot.test.ts`。

测试用例（spec 8.2）：
1. **缺少 x-node-id header 返回 400** — POST `/api/copilot` 不带 x-node-id，期望 400
2. **缺少 x-agent-id header 返回 400** — POST `/api/copilot` 带 x-node-id 但不带 x-agent-id，期望 400
3. **x-node-id 空字符串返回 400** — 期望 400
4. **节点不存在返回 404** — x-node-id 指向不存在的节点，期望 404
5. **节点离线返回 409** — x-node-id 指向 status='offline' 的节点，期望 409

这些测试需要一个内存 SQLite 数据库。参考现有测试模式创建测试 fixture。

注意：SSE 响应的完整流测试比较复杂（需要 mock daemon 发送事件），在这个任务中只测 header 校验和节点校验。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /workspaces/dev_docker/tianji-ai/apps/controlplane && pnpm vitest run src/routes/__tests__/copilot.test.ts`

Expected: FAIL。

### Step 4b: 实现

- [ ] **Step 3: 实现 copilot.ts 路由**

创建 `apps/controlplane/src/routes/copilot.ts`。

```typescript
import { Hono } from 'hono'
import type { ControlPlaneDb } from '../db/index.js'
import { TianjiAgent } from '../agents/tianji-agent.js'
// 从 @copilotkit/runtime 导入 CopilotRuntime 和 Hono 端点创建函数
// （实际导入路径以 Task 1 Step 4 探索结果为准）

export function createCopilotRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()

  // 中间件：校验 x-node-id 和 x-agent-id header
  app.use('/*', async (c, next) => {
    const nodeId = c.req.header('x-node-id')
    const agentId = c.req.header('x-agent-id')

    if (!nodeId || !agentId) {
      return c.json({ error: 'Missing x-node-id or x-agent-id header' }, 400)
    }

    // 校验节点存在性
    const node = db.raw
      .prepare('SELECT status FROM nodes WHERE node_id = ?')
      .get(nodeId) as { status: string } | undefined

    if (node === undefined) {
      return c.json({ error: 'Node not found' }, 404)
    }
    if (node.status === 'offline') {
      return c.json({ error: 'Node is offline' }, 409)
    }

    await next()
  })

  // CopilotRuntime 端点
  // 每个请求创建一个 TianjiAgent 实例，注入 nodeId/agentId
  // 使用 createCopilotEndpointHono 或等效方式挂载
  // ...（具体实现取决于 @copilotkit/runtime 的实际 API）

  return app
}
```

关键点：CopilotRuntime 的 agents 配置需要动态创建（每个请求可能指向不同节点），所以要么：
- 使用 lazy-loaded agents（`agents: () => Promise<...>`）
- 或者在中间件中创建 TianjiAgent 并挂到 context 上

具体方式以 `@copilotkit/runtime` 实际 API 为准。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /workspaces/dev_docker/tianji-ai/apps/controlplane && pnpm vitest run src/routes/__tests__/copilot.test.ts`

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
cd /workspaces/dev_docker/tianji-ai
git add apps/controlplane/src/routes/copilot.ts apps/controlplane/src/routes/__tests__/copilot.test.ts
```

使用 git-commit skill 提交。

---

## Task 5: 改造 app.ts（删旧路由、加新路由）

**Files:**
- Modify: `apps/controlplane/src/app.ts:1-49`

**依赖:** Task 4（copilot 路由）

- [ ] **Step 1: 改造 app.ts**

修改 `apps/controlplane/src/app.ts`：

1. 删除以下 import 和 route 注册：
   - `createUiTasksRoute` — `src/routes/ui-tasks.js`
   - `createTaskStreamRoute` — `src/routes/task-stream.js`
   - `createUiSessionsRoute` — `src/routes/ui-sessions.js`
   - `createUiTaskEventsRoute` — `src/routes/ui-task-events.js`

2. 新增 import 和 route 注册：
   - `import { createCopilotRoute } from './routes/copilot.js'`
   - `app.route('/', createCopilotRoute(db))`

改造后的 `createApp` 函数：

```typescript
export function createApp(db: ControlPlaneDb, logger: ObserverLogger): ControlPlaneApp {
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))

  // Node/daemon 通信路由（不动）
  app.route('/', createNodeRegisterRoute(db, logger))
  app.route('/', createNodeHeartbeatRoute(db, logger))
  app.route('/', createCommandPollRoute(db, logger))
  app.route('/', createTaskEventsRoute(db, logger))

  // UI 路由
  app.route('/', createUiNodesRoute(db))
  app.route('/', createCopilotRoute(db))
  app.route('/', createWebUiRoute())

  return {
    app,
    monitor: new ObservationMonitor(db, logger),
  }
}
```

- [ ] **Step 2: 编译检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm --filter @tianji/controlplane exec -- tsc --noEmit --project tsconfig.json`

Expected: 无类型错误。

- [ ] **Step 3: Commit**

```bash
cd /workspaces/dev_docker/tianji-ai
git add apps/controlplane/src/app.ts
```

使用 git-commit skill 提交。

---

## Task 6: 删除旧后端路由文件

**Files:**
- Delete: `apps/controlplane/src/routes/ui-tasks.ts`
- Delete: `apps/controlplane/src/routes/task-stream.ts`
- Delete: `apps/controlplane/src/routes/ui-sessions.ts`
- Delete: `apps/controlplane/src/routes/ui-task-events.ts`

**依赖:** Task 5（app.ts 已不再引用这些文件）

- [ ] **Step 1: 删除旧路由文件**

```bash
cd /workspaces/dev_docker/tianji-ai
rm apps/controlplane/src/routes/ui-tasks.ts
rm apps/controlplane/src/routes/task-stream.ts
rm apps/controlplane/src/routes/ui-sessions.ts
rm apps/controlplane/src/routes/ui-task-events.ts
```

- [ ] **Step 2: 确认无残留引用**

```bash
cd /workspaces/dev_docker/tianji-ai
grep -r "ui-tasks\|task-stream\|ui-sessions\|ui-task-events" apps/controlplane/src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v "__tests__"
```

Expected: 无输出（没有残留引用）。如果有，修复。

- [ ] **Step 3: 编译检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm --filter @tianji/controlplane exec -- tsc --noEmit --project tsconfig.json`

Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
cd /workspaces/dev_docker/tianji-ai
git add -u apps/controlplane/src/routes/
```

使用 git-commit skill 提交。

---

## Task 7: Zustand Store + 测试

**Files:**
- Create: `apps/controlplane/src/web/stores/app-store.ts`
- Create: `apps/controlplane/src/web/stores/__tests__/app-store.test.ts`
- Create: `apps/controlplane/src/web/lib/nodes-api.ts`

**参考文档:**
- Spec 5.2 Zustand Store（`docs/superpowers/specs/2026-04-10-controlplane-web-ui-redesign.md:266-286`）
- 现有 api.ts 的 fetchNodes 函数（`apps/controlplane/src/web/lib/api.ts:19-26`）
- 现有 UiNode/UiNodeAgent 类型（`apps/controlplane/src/web/lib/api.ts:1-10`）

### Step 7a: 写测试

- [ ] **Step 1: 编写 store 测试**

创建 `apps/controlplane/src/web/stores/__tests__/app-store.test.ts`。

测试用例（spec 8.3）：
1. **fetchNodes 更新 nodes 和 nodesLoading** — mock fetch，调用 `fetchNodes()`，断言 `nodesLoading` 先变 true 再变 false，`nodes` 被更新
2. **selectNode 联动更新 agentId** — 调用 `selectNode('node-1', 'agent-1')`，断言 `selectedNodeId` 和 `selectedAgentId` 都被设置
3. **selectNode 切换节点时 sessionId 清空** — 先 `setSessionId('session-1')`，再 `selectNode('node-2', 'agent-2')`，断言 `sessionId` 变为 `null`

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /workspaces/dev_docker/tianji-ai/apps/controlplane && pnpm vitest run src/web/stores/__tests__/app-store.test.ts`

Expected: FAIL。

### Step 7b: 实现

- [ ] **Step 3: 创建 nodes-api.ts**

创建 `apps/controlplane/src/web/lib/nodes-api.ts`：

```typescript
export interface UiNodeAgent {
  readonly agentId: string
}

export interface UiNode {
  readonly nodeId: string
  readonly hostname: string
  readonly status: string
  readonly agents: readonly UiNodeAgent[]
}

/**
 * 获取 controlplane UI 可见节点列表。
 */
export async function fetchNodes(): Promise<readonly UiNode[]> {
  const response = await fetch('/api/ui/nodes')
  if (!response.ok) {
    throw new Error(`Failed to fetch nodes: ${response.status}`)
  }
  return (await response.json()) as UiNode[]
}
```

- [ ] **Step 4: 创建 app-store.ts**

创建 `apps/controlplane/src/web/stores/app-store.ts`：

```typescript
import { create } from 'zustand'
import { type UiNode, fetchNodes } from '../lib/nodes-api'

export interface AppState {
  nodes: UiNode[]
  nodesLoading: boolean
  fetchNodes: () => Promise<void>

  selectedNodeId: string | null
  selectedAgentId: string | null
  selectNode: (nodeId: string, agentId: string) => void

  sessionId: string | null
  setSessionId: (id: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  nodes: [],
  nodesLoading: false,
  fetchNodes: async () => {
    set({ nodesLoading: true })
    try {
      const nodes = await fetchNodes()
      set({ nodes: [...nodes], nodesLoading: false })
    } catch {
      set({ nodesLoading: false })
    }
  },

  selectedNodeId: null,
  selectedAgentId: null,
  selectNode: (nodeId, agentId) => {
    set({ selectedNodeId: nodeId, selectedAgentId: agentId, sessionId: null })
  },

  sessionId: null,
  setSessionId: (id) => {
    set({ sessionId: id })
  },
}))
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /workspaces/dev_docker/tianji-ai/apps/controlplane && pnpm vitest run src/web/stores/__tests__/app-store.test.ts`

Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
cd /workspaces/dev_docker/tianji-ai
git add apps/controlplane/src/web/stores/app-store.ts apps/controlplane/src/web/stores/__tests__/app-store.test.ts apps/controlplane/src/web/lib/nodes-api.ts
```

使用 git-commit skill 提交。

---

## Task 8: 前端 UI 重写（布局 + CopilotKit 集成）

**Files:**
- Create: `apps/controlplane/src/web/components/layout.tsx`
- Create: `apps/controlplane/src/web/components/workspace-panel.tsx`
- Modify: `apps/controlplane/src/web/main.tsx`
- Modify: `apps/controlplane/src/web/routes/index.tsx`
- Modify: `apps/controlplane/src/web/components/node-list.tsx`

**依赖:** Task 7（Zustand store）

**参考文档:**
- Spec 5.3 Provider 层级（`docs/superpowers/specs/2026-04-10-controlplane-web-ui-redesign.md:301-329`）
- Spec 5.5 三栏布局（`docs/superpowers/specs/2026-04-10-controlplane-web-ui-redesign.md:344-360`）
- Spec 5.2.1 CopilotChat 业务约束分工（`docs/superpowers/specs/2026-04-10-controlplane-web-ui-redesign.md:288-299`）
- CopilotKit 的 `<CopilotKit>` provider 和 `<CopilotChat>` 组件 API
- `@copilotkit/react-ui` 的样式导入方式

- [ ] **Step 1: 创建 workspace-panel.tsx**

创建 `apps/controlplane/src/web/components/workspace-panel.tsx`：

```typescript
export function WorkspacePanel() {
  return (
    <div className="workspace-panel">
      <div className="workspace-placeholder">
        <p>工作区</p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 改造 node-list.tsx**

修改 `apps/controlplane/src/web/components/node-list.tsx`，将数据源从 props 改为直接读 Zustand store：

```typescript
import { useAppStore } from '../stores/app-store'

export function NodeList() {
  const { nodes, selectedNodeId, selectNode } = useAppStore()

  return (
    <aside className="node-list">
      <h1 className="brand">Tianji</h1>
      <p className="subtitle">Controlplane</p>
      {nodes.map((node) => {
        const firstAgent = node.agents[0]
        const disabled = node.status !== 'online' || firstAgent === undefined
        const active = node.nodeId === selectedNodeId

        return (
          <button
            key={node.nodeId}
            className={active ? 'node-item active' : 'node-item'}
            disabled={disabled}
            onClick={() => {
              if (firstAgent !== undefined) {
                selectNode(node.nodeId, firstAgent.agentId)
              }
            }}
            type="button"
          >
            <strong>{node.hostname}</strong>
            <div className="node-meta">
              {node.nodeId} · {node.status} · agents: {node.agents.length}
            </div>
          </button>
        )
      })}
    </aside>
  )
}
```

- [ ] **Step 3: 创建 layout.tsx**

创建 `apps/controlplane/src/web/components/layout.tsx`：

```typescript
import { CopilotChat } from '@copilotkit/react-ui'
// 导入 CopilotKit 默认样式（路径以实际包为准）
import '@copilotkit/react-ui/styles.css'

import { useAppStore } from '../stores/app-store'
import { NodeList } from './node-list'
import { WorkspacePanel } from './workspace-panel'

export function Layout() {
  const { selectedNodeId } = useAppStore()
  const chatDisabled = selectedNodeId === null

  return (
    <div className="app-layout">
      <NodeList />
      <WorkspacePanel />
      <div className="chat-panel">
        {chatDisabled ? (
          <div className="chat-disabled">
            <p>请先选择一个在线节点</p>
          </div>
        ) : (
          <CopilotChat
            className="tianji-chat"
            labels={{
              initial: '选择一个节点后发送消息',
              placeholder: '输入你的任务或问题',
            }}
          />
        )}
      </div>
    </div>
  )
}
```

注意：`CopilotChat` 的具体 props API 以 `@copilotkit/react-ui` 实际版本为准。可能需要查看包的类型定义来确认可用 props。

- [ ] **Step 4: 改造 index.tsx**

重写 `apps/controlplane/src/web/routes/index.tsx`：

```typescript
import { CopilotKit } from '@copilotkit/react-core'
import { createRoute } from '@tanstack/react-router'
import { useEffect } from 'react'

import { Layout } from '../components/layout'
import { useAppStore } from '../stores/app-store'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/',
  component: IndexRouteComponent,
})

export function IndexRouteComponent() {
  const { fetchNodes, selectedNodeId, selectedAgentId } = useAppStore()

  useEffect(() => {
    void fetchNodes()
  }, [fetchNodes])

  // 自动选择第一个在线节点
  const { nodes, selectNode } = useAppStore()
  useEffect(() => {
    if (selectedNodeId !== null) return
    const firstOnline = nodes.find(
      (n) => n.status === 'online' && n.agents[0] !== undefined
    )
    if (firstOnline !== undefined) {
      selectNode(firstOnline.nodeId, firstOnline.agents[0]!.agentId)
    }
  }, [nodes, selectedNodeId, selectNode])

  return (
    <CopilotKit
      runtimeUrl="/api/copilot"
      headers={{
        'x-node-id': selectedNodeId ?? '',
        'x-agent-id': selectedAgentId ?? '',
      }}
    >
      <Layout />
    </CopilotKit>
  )
}
```

- [ ] **Step 5: 改造 main.tsx**

重写 `apps/controlplane/src/web/main.tsx`：

```typescript
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { router } from './router'
import './styles.css'

const rootElement = document.getElementById('root')

if (rootElement === null) {
  throw new Error('Missing root element')
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
)
```

- [ ] **Step 6: 编译检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm --filter @tianji/controlplane exec -- tsc --noEmit --project tsconfig.web.json`

Expected: 无错误。如果有 CopilotKit 类型问题，根据实际 API 调整。

- [ ] **Step 7: Commit**

```bash
cd /workspaces/dev_docker/tianji-ai
git add apps/controlplane/src/web/components/layout.tsx apps/controlplane/src/web/components/workspace-panel.tsx apps/controlplane/src/web/main.tsx apps/controlplane/src/web/routes/index.tsx apps/controlplane/src/web/components/node-list.tsx
```

使用 git-commit skill 提交。

---

## Task 9: 删除旧前端文件

**Files:**
- Delete: `apps/controlplane/src/web/lib/api.ts`
- Delete: `apps/controlplane/src/web/lib/task-stream.ts`
- Delete: `apps/controlplane/src/web/lib/query-client.ts`
- Delete: `apps/controlplane/src/web/lib/__tests__/task-stream.test.ts`
- Delete: `apps/controlplane/src/web/components/chat-shell.tsx`
- Delete: `apps/controlplane/src/web/components/chat-composer.tsx`
- Delete: `apps/controlplane/src/web/components/message-list.tsx`

**依赖:** Task 8（新前端已不引用这些文件）

- [ ] **Step 1: 删除旧前端文件**

```bash
cd /workspaces/dev_docker/tianji-ai
rm apps/controlplane/src/web/lib/api.ts
rm apps/controlplane/src/web/lib/task-stream.ts
rm apps/controlplane/src/web/lib/query-client.ts
rm -f apps/controlplane/src/web/lib/__tests__/task-stream.test.ts
rm apps/controlplane/src/web/components/chat-shell.tsx
rm apps/controlplane/src/web/components/chat-composer.tsx
rm apps/controlplane/src/web/components/message-list.tsx
```

- [ ] **Step 2: 确认无残留引用**

```bash
cd /workspaces/dev_docker/tianji-ai
grep -r "chat-shell\|chat-composer\|message-list\|query-client\|task-stream\|from.*['\"].*\/api['\"]" apps/controlplane/src/web/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v nodes-api
```

Expected: 无输出。

- [ ] **Step 3: 编译检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm --filter @tianji/controlplane exec -- tsc --noEmit --project tsconfig.web.json`

Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
cd /workspaces/dev_docker/tianji-ai
git add -u apps/controlplane/src/web/
```

使用 git-commit skill 提交。

---

## Task 10: UI 视觉重设计（styles.css）

**Files:**
- Rewrite: `apps/controlplane/src/web/styles.css`

**依赖:** Task 8（布局组件的 className 已确定）

**必须:** 在开始实现前，调用 `frontend-aesthetics` skill 获取视觉设计指导。

- [ ] **Step 1: 调用 frontend-aesthetics skill**

使用 `frontend-aesthetics` skill，输入以下上下文：
- 这是一个开发者工具的 controlplane 界面
- 暗色主题
- 三栏布局：左侧 250px 节点列表，中间 1fr 工作区，右侧 400px 聊天区
- 需要覆盖 CopilotKit 的默认样式
- 字体：Inter 或等宽
- 响应式：窄屏三栏→两栏→单栏

- [ ] **Step 2: 重写 styles.css**

根据 frontend-aesthetics skill 的指导，完整重写 `apps/controlplane/src/web/styles.css`。

必须包含：
- CSS 变量定义（颜色、间距、字体）
- `.app-layout` 三栏 grid 布局
- `.node-list` / `.node-item` / `.node-item.active` 样式
- `.workspace-panel` / `.workspace-placeholder` 样式
- `.chat-panel` / `.chat-disabled` 样式
- `.tianji-chat` 覆盖 CopilotKit 默认样式（颜色、背景、边框等）
- 响应式 media queries
- CopilotKit CSS 变量覆盖（如 `--copilot-kit-primary-color` 等，具体变量名以 `@copilotkit/react-ui/styles.css` 中实际定义为准）

- [ ] **Step 3: 构建前端确认无错误**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm --filter @tianji/controlplane run build:web`

Expected: 构建成功。

- [ ] **Step 4: Commit**

```bash
cd /workspaces/dev_docker/tianji-ai
git add apps/controlplane/src/web/styles.css
```

使用 git-commit skill 提交。

---

## Task 11: 全量检查

**依赖:** 所有前述 Task

- [ ] **Step 1: TypeScript 检查（后端 + 前端）**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm --filter @tianji/controlplane run typecheck`

Expected: 无错误。

- [ ] **Step 2: 运行所有测试**

Run: `cd /workspaces/dev_docker/tianji-ai/apps/controlplane && pnpm vitest run`

Expected: 全部 PASS。

- [ ] **Step 3: 完整构建**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm --filter @tianji/controlplane run build`

Expected: 构建成功。

- [ ] **Step 4: pnpm check**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`

Expected: 无错误、无警告。如果有，修复并重新运行。

- [ ] **Step 5: 最终 Commit（如有修复）**

如果 Step 1-4 中有修复，提交修复。使用 git-commit skill。
