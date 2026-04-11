# Controlplane Web UI 重构设计

## 1. 背景与目标

当前 controlplane web UI 是一个极简的 React SPA，使用 React Query 管理服务端状态，自定义 SSE 协议与后端通信。存在以下问题：

1. 无全局状态管理，所有状态散落在 `index.tsx` 的 `useState` 中
2. SSE 协议是自定义的，前端只处理了 `task.lifecycle` 和 `agent.message.delta` 两种事件，丢失了工具调用、思考过程、编排图执行等事件
3. UI 简陋，无设计感
4. 布局只有两栏，无法扩展

本设计的目标：

1. 引入 Zustand 进行全局状态管理
2. 引入 CopilotKit（全量：CopilotRuntime + 前端组件），Browser ↔ Controlplane 通信改用 AG-UI 协议
3. 三栏布局：节点列表 + 工作区（预留） + 聊天区
4. 用 frontend-aesthetics 指导 UI 视觉重设计
5. 功能范围不变：选节点 → 发任务 → 看流式回复

## 2. 设计原则

| 原则 | 说明 |
|------|------|
| 只改前段 | AG-UI 协议仅用于 Browser ↔ Controlplane，Node/daemon 通信不动 |
| 旧端点全删 | controlplane 处于早期开发，不考虑兼容性，旧的 UI 端点全部删除 |
| 保持 Hono | 后端框架不变，CopilotRuntime 手动集成到 Hono |
| 功能不增 | 保持当前最简功能，不加新特性 |

## 3. 整体架构

### 改造前

```
Browser                     Controlplane后端                    Daemon
  |                              |                               |
  |--GET /api/ui/nodes---------> |                               |
  |--POST /api/ui/tasks--------> | --(command)-----------------> |
  |--GET /api/ui/tasks/:id/stream|  <-(task_events轮询SQLite)    |
  |  (自定义SSE: task.lifecycle,  |                               |
  |   agent.message.delta, done) |                               |
```

### 改造后

```
Browser                     Controlplane后端                    Daemon
  |                              |                               |
  |  <CopilotKit runtimeUrl=     |                               |
  |   "/api/copilot">            |                               |
  |                              |                               |
  |--POST /api/copilot---------> | CopilotRuntime                |
  |  (AG-UI协议)                 |   +-- TianjiAgent(自定义)     |
  |<-(AG-UI SSE事件流)---------- |       |-- 创建task            |
  |  TEXT_MESSAGE_START          |       |-- 轮询task_events     |
  |  TEXT_MESSAGE_CONTENT        |       |-- 翻译为AG-UI事件     |
  |  TEXT_MESSAGE_END            |       +-- 推送给Runtime       |
  |  RUN_STARTED/RUN_FINISHED   | --(command)-----------------> |
  |  TOOL_CALL_START/END        | <-(task_events)               |
  |  STEP_STARTED/FINISHED      |                               |
  |                              |                               |
  |--GET /api/ui/nodes---------> | (保留，CopilotKit不管节点选择) |
```

## 4. 后端改造

### 4.1 路由变更

**删除的路由文件：**

| 文件 | 原因 |
|------|------|
| `src/routes/ui-tasks.ts` | 被 CopilotRuntime 替代 |
| `src/routes/task-stream.ts` | 被 AG-UI SSE 替代 |
| `src/routes/ui-sessions.ts` | 前端不再直接管 session。**能力收缩：本次重构接受"页面刷新后不恢复历史 session、不能切换旧 session、不能展示 session 列表"。** 后续如需会话恢复功能，需重新实现 session 列表端点 |
| `src/routes/ui-task-events.ts` | 前端不再直接查事件 |

**保留的：**

| 文件 | 原因 |
|------|------|
| `src/routes/ui-nodes.ts` | 节点列表与 CopilotKit 无关 |
| `src/routes/web-ui.ts` | SPA 静态文件服务 |
| `src/services/*` | 服务层逻辑不变，TianjiAgent 内部调用 |
| `src/db/*` | 数据库层不变 |

**`app.ts` 改造后：**

```typescript
app.route('/api/ui/nodes', createUiNodesRoute(...))     // 保留
app.route('/api/copilot', createCopilotRoute(...))       // 新增
app.route('', createWebUiRoute(...))                     // 保留
```

### 4.2 新增：CopilotRuntime 路由

文件：`src/routes/copilot.ts`

职责：接收 AG-UI 请求，委派给 TianjiAgent 处理。

```typescript
// POST /api/copilot
// 1. 从请求头读取 x-node-id、x-agent-id
// 2. 创建 TianjiAgent 实例（注入 nodeId、agentId、服务层依赖）
// 3. CopilotRuntime 处理请求，返回 AG-UI SSE 流
```

### 4.3 新增：TianjiAgent

文件：`src/agents/tianji-agent.ts`

职责：桥接 AG-UI 协议与现有 task/event 服务。实现一个 AG-UI 兼容的 agent 适配器，具体继承基类或实现接口以实际安装的 `@ag-ui/client` 和 `@copilotkit/runtime` 版本 API 为准。

核心逻辑（与具体基类/接口签名无关）：

```
1. 从请求 input 中提取用户消息
2. 从构造参数中获取 nodeId / agentId
3. 校验 nodeId / agentId 有效性（不存在或离线直接报错）
4. 调用现有 service 创建 task
5. 发送 STATE_SNAPSHOT（初始状态）
6. 轮询 task_events（复用现有 event-store 逻辑）
7. 按 4.4 事件映射表将 task_events 翻译为 AG-UI 事件
8. 推送事件给 CopilotRuntime
9. task 进入终态后结束流
```

### 4.4 事件映射表

#### 4.4.1 生命周期事件

| 现有 task_event | AG-UI 事件 | 说明 |
|-----------------|------------|------|
| `task.started` | `RUN_STARTED` | 任务开始 |
| `task.completed` | `RUN_FINISHED` | 任务完成 |
| `task.failed` | `RUN_ERROR` | 任务失败 |
| `task.cancelled` | `RUN_ERROR` | 任务取消 |
| `task.waiting` | `STATE_DELTA` | 见 4.4.6 状态结构定义 |
| `task.session.attached` | `STATE_DELTA` | 见 4.4.6 状态结构定义 |

#### 4.4.2 消息事件

| 现有 task_event | AG-UI 事件 | 说明 |
|-----------------|------------|------|
| `message.started` | `TEXT_MESSAGE_START` | 消息流开始 |
| `message.delta` (channel='text') | `TEXT_MESSAGE_CONTENT` | 文本增量 |
| `message.delta` (channel='thinking') | `REASONING_MESSAGE_CONTENT` | 思考过程增量，见 4.4.5 |
| `message.completed` | `TEXT_MESSAGE_END` | 消息流结束 |

#### 4.4.3 工具调用事件

runtime 的 `tool.started` 事件中 `invocation` 字段已携带完整的工具名和参数（`ToolInvocation.toolName` + `ToolInvocation.args`）。不做 `TOOL_CALL_ARGS` 流式参数展示，在 `TOOL_CALL_START` 中一次性带完整参数。

| 现有 task_event | AG-UI 事件 | payload 映射 |
|-----------------|------------|-------------|
| `tool.started` | `TOOL_CALL_START` | `{ toolCallId: invocation.toolCallId, toolCallName: invocation.toolName, args: JSON.stringify(invocation.args) }` |
| `tool.completed` | `TOOL_CALL_END` + `TOOL_CALL_RESULT` | END: `{ toolCallId }`, RESULT: `{ toolCallId, result: JSON.stringify(result.result) }` |
| `tool.failed` | `TOOL_CALL_END` | `{ toolCallId, error: error.message }` |

不发 `TOOL_CALL_ARGS` 事件。原因：当前 runtime 不支持流式参数输出，`tool.started` 已经包含完整参数。

#### 4.4.4 运行与编排图事件

run.* 和 graph.* 语义不同，不能混为一谈。所有 `STEP_*` 事件必须携带 `metadata` 字段保留原始语义，供未来工作区编排图视图使用。

| 现有 task_event | AG-UI 事件 | metadata |
|-----------------|------------|----------|
| `run.started` | `STEP_STARTED` | `{ stepKind: 'run', runId, sessionId, triggerType }` |
| `run.completed` | `STEP_FINISHED` | `{ stepKind: 'run', runId }` |
| `run.failed` | `STEP_FINISHED` | `{ stepKind: 'run', runId, error }` |
| `run.cancelled` | `STEP_FINISHED` | `{ stepKind: 'run', runId, cancelled: true }` |
| `graph.started` | `STEP_STARTED` | `{ stepKind: 'graph', graphId, graphVersion }` |
| `graph.node.started` | `STEP_STARTED` | `{ stepKind: 'graph-node', graphId, nodeId, nodeKind }` |
| `graph.node.completed` | `STEP_FINISHED` | `{ stepKind: 'graph-node', graphId, nodeId, output }` |
| `graph.node.failed` | `STEP_FINISHED` | `{ stepKind: 'graph-node', graphId, nodeId, error }` |
| `graph.completed` | `STEP_FINISHED` | `{ stepKind: 'graph', graphId, finalState }` |

metadata 类型定义：

```typescript
type StepMetadata =
  | { stepKind: 'run'; runId: string; sessionId?: string; triggerType?: string; error?: unknown; cancelled?: boolean }
  | { stepKind: 'graph'; graphId: string; graphVersion?: number; finalState?: Record<string, unknown> }
  | { stepKind: 'graph-node'; graphId: string; nodeId: string; nodeKind?: string; output?: Record<string, unknown>; error?: unknown }
```

#### 4.4.5 思考/推理事件

当前 runtime 已支持 `message.delta` 的 `channel` 字段（`'text' | 'thinking'`，定义于 `packages/shared/src/events.ts:69`）。当 `channel === 'thinking'` 时，映射为 AG-UI 的 REASONING 系列事件：

| 场景 | AG-UI 事件序列 |
|------|---------------|
| 首个 thinking delta | `REASONING_START` → `REASONING_MESSAGE_START` → `REASONING_MESSAGE_CONTENT` |
| 后续 thinking delta | `REASONING_MESSAGE_CONTENT` |
| thinking 结束（收到 `message.completed` 或 channel 切回 text） | `REASONING_MESSAGE_END` → `REASONING_END` |

当前 UI 不做 thinking 通道的专门渲染（CopilotChat 默认不展示 REASONING 事件），但协议层必须正确翻译，不丢弃。

#### 4.4.6 STATE_DELTA 状态结构

通过 AG-UI 的 `STATE_DELTA` 事件传递的状态，必须遵守以下 shape：

```typescript
interface TianjiCopilotState {
  /** 当前关联的 session ID */
  sessionId: string | null
  /** 任务状态 */
  taskStatus: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | null
  /** 当前 task ID */
  taskId: string | null
}
```

映射规则：

| task_event | STATE_DELTA patch（JSON Patch 语义） |
|------------|--------------------------------------|
| `task.session.attached` | `[{ op: 'replace', path: '/sessionId', value: '<sessionId>' }]` |
| `task.waiting` | `[{ op: 'replace', path: '/taskStatus', value: 'waiting' }]` |
| `task.started` | `[{ op: 'replace', path: '/taskStatus', value: 'running' }, { op: 'replace', path: '/taskId', value: '<taskId>' }]` |
| `task.completed` | `[{ op: 'replace', path: '/taskStatus', value: 'completed' }]` |
| `task.failed` | `[{ op: 'replace', path: '/taskStatus', value: 'failed' }]` |
| `task.cancelled` | `[{ op: 'replace', path: '/taskStatus', value: 'cancelled' }]` |

初始 state snapshot 在 `RUN_STARTED` 之前发送：

```typescript
// STATE_SNAPSHOT 事件
{ sessionId: null, taskStatus: null, taskId: null }
```

## 5. 前端架构

### 5.1 文件变更

**删除的文件：**

| 文件 | 原因 |
|------|------|
| `src/web/lib/task-stream.ts` | SSE 由 CopilotKit 内部处理 |
| `src/web/lib/query-client.ts` | React Query 移除 |
| `src/web/components/chat-shell.tsx` | 重写为新布局 |
| `src/web/components/chat-composer.tsx` | 被 CopilotChat 自带输入框替代 |
| `src/web/components/message-list.tsx` | 被 CopilotChat 自带消息列表替代 |
| `src/web/styles.css` | 全部重写 |
| `src/web/lib/api.ts` | 整个删除，`fetchNodes()` 迁移到新的 `nodes-api.ts` |

**保留并改造的：**

| 文件 | 改动 |
|------|------|
| `src/web/components/node-list.tsx` | 数据源从 React Query 改为 Zustand |
| `src/web/routes/index.tsx` | 大幅简化，状态移入 Zustand，聊天委托给 CopilotKit |
| `src/web/main.tsx` | Provider 换为 `<CopilotKit>` |
| `src/web/router.tsx` | 不变 |
| `src/web/routes/__root.tsx` | 不变 |

**新增的：**

| 文件 | 职责 |
|------|------|
| `src/web/stores/app-store.ts` | Zustand store |
| `src/web/lib/nodes-api.ts` | 仅保留 `fetchNodes()` |
| `src/web/components/layout.tsx` | 三栏布局容器 |
| `src/web/components/workspace-panel.tsx` | 中间工作区空面板 |

### 5.2 Zustand Store

```typescript
interface AppState {
  // 节点数据
  nodes: UiNode[]
  nodesLoading: boolean
  fetchNodes: () => Promise<void>

  // 选中状态
  selectedNodeId: string | null
  selectedAgentId: string | null
  selectNode: (nodeId: string, agentId: string) => void

  // session（由 CopilotKit 的 STATE_DELTA 事件回写）
  sessionId: string | null
  setSessionId: (id: string) => void
}
```

`messages`、`sending`、`streamCleanup` 不放 Zustand，由 CopilotKit 内部管理。

### 5.2.1 CopilotChat 业务约束分工

CopilotChat 不是接上就完事，以下业务约束需要外层包装组件补回：

| 业务约束 | 责任方 | 实现方式 |
|----------|--------|----------|
| 未选节点不能发消息 | 外层包装组件 | 读 Zustand store，未选中时禁用 CopilotChat 输入框 |
| 选节点联动选 agent | Zustand store | `selectNode` action 同时设置 agentId |
| 切节点时 session 清空 | Zustand store | `selectNode` action 重置 sessionId 为 null |
| 流结束但无文本输出时显示提示 | TianjiAgent 后端 | task 进入终态但无 message 事件时，发一条 `TEXT_MESSAGE_CONTENT` 带提示文案（如"任务已完成，但未产生输出"） |
| 失败时显示错误信息 | CopilotKit 默认行为 | CopilotKit 收到 `RUN_ERROR` 后会在 UI 展示错误，如默认展示不符合要求则通过 CSS/自定义组件覆盖 |
| 错误文案来源 | TianjiAgent 后端 | `RUN_ERROR` 事件的 message 字段取自 `task.failed` 的 error payload |

### 5.3 Provider 层级

React Query 的 `QueryClientProvider` 删除。

`<CopilotKit>` 不能放在最外层，因为它需要从 Zustand store 读取 `selectedNodeId` / `selectedAgentId` 作为 headers。Provider 结构如下：

```typescript
// main.tsx
<RouterProvider router={router} />

// routes/index.tsx（或 layout.tsx）
function AppLayout() {
  const { selectedNodeId, selectedAgentId } = useAppStore()

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

`<CopilotKit>` 放在能访问 Zustand store 的组件内部，确保 headers 随选中节点实时更新。

### 5.4 nodeId/agentId 传递与校验

**前端约束：**
- 未选中 node/agent 时，CopilotChat 输入框必须禁用，不允许发送消息
- 切换节点时清空 sessionId，避免串会话
- 不允许默认节点兜底（符合 Let it crash 原则）

**后端约束：**
- `copilot.ts` 路由收到请求时，校验 `x-node-id` 和 `x-agent-id` header
- 缺失或为空字符串：返回 400
- 节点不存在：返回 404
- 节点离线：返回 409

### 5.5 三栏布局

```
+----------+----------------------+----------------+
|          |                      |                |
|  节点列表 |     工作区            |  CopilotChat   |
|  250px   |     1fr              |  400px         |
|          |                      |                |
|  - 节点A  |     (空面板)          |  [消息列表]     |
|  - 节点B  |     "未来在此         |  [工具调用卡片] |
|  - 节点C  |      展示编排图"      |  [思考过程]     |
|          |                      |  [输入框]       |
|          |                      |                |
+----------+----------------------+----------------+
```

响应式：窄屏时三栏变两栏（隐藏工作区），更窄时变单栏。

## 6. 依赖变更

### 新增

| 包名 | 用途 |
|------|------|
| `zustand` | 前端状态管理 |
| `@copilotkit/react-core` | CopilotKit 前端核心 |
| `@copilotkit/react-ui` | CopilotKit 预置 UI 组件 |
| `@copilotkit/runtime` | CopilotRuntime 后端集成 |
| `@ag-ui/client` | AG-UI 协议类型和 AbstractAgent 基类 |

### 移除

| 包名 | 原因 |
|------|------|
| `@tanstack/react-query` | 被 Zustand 替代 |

### 保留

| 包名 | 原因 |
|------|------|
| `@tanstack/react-router` | 路由不变 |
| `hono` / `@hono/node-server` | 后端框架不变 |
| `better-sqlite3` | 数据库不变 |
| `react` / `react-dom` | 前端框架 |

## 7. UI 视觉风格

| 约束 | 说明 |
|------|------|
| 暗色主题 | 保持暗色基调，controlplane 是开发者工具 |
| CopilotChat 样式覆盖 | 通过 CSS 变量或自定义 className 覆盖为统一风格 |
| 响应式 | 窄屏三栏→两栏→单栏 |
| 字体 | Inter 或等宽字体 |

具体配色、间距、阴影等细节在实现阶段由 `frontend-aesthetics` skill 指导。

## 8. 测试覆盖

### 8.1 TianjiAgent 事件映射（单元测试）

文件：`src/agents/__tests__/tianji-agent.test.ts`

| 测试点 | 说明 |
|--------|------|
| lifecycle 事件映射为 RUN_STARTED / RUN_FINISHED / RUN_ERROR | 覆盖 started/completed/failed/cancelled |
| message.delta (channel='text') 映射为 TEXT_MESSAGE_CONTENT | 文本通道 |
| message.delta (channel='thinking') 映射为 REASONING_MESSAGE_CONTENT | 思考通道，协议层不丢弃 |
| tool.started 映射为 TOOL_CALL_START 并携带完整参数 | 验证 invocation.args 序列化到 TOOL_CALL_START |
| tool.completed 映射为 TOOL_CALL_END + TOOL_CALL_RESULT | 验证 result 正确传递 |
| tool.failed 映射为 TOOL_CALL_END + error | |
| run.* 映射为 STEP_* 并携带 metadata.stepKind='run' | 验证 metadata 保留语义 |
| graph.* 映射为 STEP_* 并携带 metadata.stepKind='graph'/'graph-node' | 验证 graphId/nodeId/nodeKind 保留 |
| task.session.attached 映射为 STATE_DELTA 且 patch 结构正确 | 验证 JSON Patch 格式和 sessionId 值 |
| task.waiting 映射为 STATE_DELTA 且 taskStatus='waiting' | |
| task 创建失败时返回 RUN_ERROR | |
| task 进入终态但无 message 事件时发送提示文案 | 空输出兜底 |

### 8.2 Copilot 路由（集成测试）

文件：`src/routes/__tests__/copilot.test.ts`

| 测试点 | 说明 |
|--------|------|
| 正常请求返回 SSE 响应 | |
| 缺少 x-node-id / x-agent-id header 返回 400 | 参数校验 |
| x-node-id 对应节点不存在返回 404 | |
| x-node-id 对应节点离线返回 409 | |

### 8.3 Zustand Store（单元测试）

文件：`src/web/stores/__tests__/app-store.test.ts`

| 测试点 | 说明 |
|--------|------|
| fetchNodes 正确更新 nodes 和 nodesLoading | |
| selectNode 联动更新 selectedAgentId | |
| selectNode 切换节点时 sessionId 清空 | 避免串会话 |

## 9. 不改动的

| 项 | 原因 |
|----|------|
| Node/daemon 通信协议 | AG-UI 仅用于 Browser ↔ Controlplane |
| `src/services/*` | 服务层逻辑不变，TianjiAgent 内部调用 |
| `src/db/*` | 数据库层不变 |
| `src/routes/task-events.ts`（daemon 上报端点） | daemon 向 controlplane 上报事件的入口不变 |
| `src/middleware/*` | 不变 |
