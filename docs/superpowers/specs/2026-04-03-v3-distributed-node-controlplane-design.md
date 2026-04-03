# V3 设计：分布式节点与控制平面

> 状态：规划中
> 日期：2026-04-03

---

## 1. 目标

tianji 扩展为**分布式多节点架构**，实现两个目标：

1. **接入标准 ACP 生态**：`apps/node`（原 `apps/cli`）作为 ACP client，通过官方 TypeScript SDK（`@agentclientprotocol/sdk`）管理本地 ACP 兼容 agent，包括第三方 agent（Claude Code、Codex CLI 等）
2. **统一控制平面**：新增 `apps/controlplane` Web 应用，统一管理所有设备上的 node，从单一入口查看 agent 状态、下发任务、查阅日志（有限保留窗口，非完整审计）

## 1.1 术语

| 术语 | Owner | 含义 | 持久化位置 |
|------|-------|------|------------|
| `Task` | Control Plane | 长期工作对象，表示用户委托给 node/agent 的目标 | controlplane |
| `Session` | Node / Agent Runtime | 长生命周期对话上下文，可独立存在，也可被 task 引用 | node 本地 |
| `Run` | Runtime | `session` 内一次 turn 执行 | node 本地 |

```text
User
  ├─ creates Task
  └─ starts Session directly on Node

Task
  ↔ Session

Session
  └─ Run
```

约束：

1. `task ↔ session` 为多对多关系
2. `1 session : N run`
3. `task` 是长期工作对象，不等于单次 prompt，也不等于单次 run
4. `sessionId` 只在创建它的 node 上有效，V3 不支持 session 跨 node 迁移
5. 同一时刻同一 `session` 不允许被多个 active task 并发写入
6. Control Plane 不是完整会话事实源；完整聊天内容以 node 上的 `session` 为准

## 1.2 用户入口

| 入口 | 用户动作 | 直接产物 | 用途 |
|------|----------|----------|------|
| Direct Chat | 选择 `node + agent` 直接聊天 | `Session` | 交互式对话 |
| Task | 创建长期工作 | `Task` | 委托、跟踪、等待、继续推进 |

补充：

1. 直接聊天创建的 `session` 可后续被 `task` 引用
2. task 执行过程中创建的 `session` 可后续继续聊天

---

## 2. 整体架构

```
┌──────────────────────────────────────────────────┐
│              Control Plane (Web App)             │
│                                                  │
│   Node Registry │ Agent View │ Task Monitor      │
│                                                  │
│   REST API ◄─── Web UI (browser)                │
│   Long Poll Endpoint ◄──── Node (主动轮询)        │
└───────────────────────────┬──────────────────────┘
                            │
                HTTP/HTTPS 长轮询（V3）
                Node 主动发起，穿透 NAT/防火墙
                            │
           ┌────────────────┼────────────────┐
           │                │                │
     ┌─────▼──────┐  ┌──────▼─────┐  ┌──────▼─────┐
     │   Node A   │  │   Node B   │  │   Node C   │
     │  (设备 A)  │  │  (设备 B)  │  │  (设备 C)  │
     │            │  │            │  │            │
     │  CLI 交互  │  │  CLI 交互  │  │  CLI 交互  │
     └─────┬──────┘  └─────┬──────┘  └────────────┘
           │               │
           │  ACP (JSON-RPC 2.0 over stdio)
           │  ClientSideConnection
           │  (@agentclientprotocol/sdk)
           │
      ┌────┴────┐
      │    │    │
     A1   A2   A3*

A1/A2 = tianji 原生 agent（独立可执行文件，实现 AgentSideConnection）
A3*   = 第三方 ACP agent（Claude Code、Codex CLI 等，无需适配）
```

---

## 3. 包结构变化

```
tianji-ai/
├─ packages/
│  ├─ shared/        # L0（扩展：RuntimeEvent 类型迁移至此）
│  ├─ observer/      # 可观测性（node 和 controlplane 共用，日志文件路径独立）
│  ├─ runtime/       # L1（不变，RuntimeEvent 从 shared 取）
│  └─ agent/         # L2（扩展：实现 AgentSideConnection，编译为独立可执行文件）
├─ apps/
│  ├─ node/          # 原 cli，重命名 + 扩展
│  └─ controlplane/  # 新增 Web 应用
```

### 3.1 `apps/node`（原 `apps/cli`）

重命名，定位为**设备级 agent 管理器**。保留全部 CLI 交互命令（`run` / `chat` / `daemon` 等），在此基础上扩展：

- ACP 适配（`src/acp/`）：直接依赖 `@agentclientprotocol/sdk`，在 app 内部完成协议适配
  - `ClientSideConnection` → `AsyncIterable<RuntimeEvent>` 映射
  - `AgentSession.chat()` → `AgentSideConnection` 桥接
- 控制平面连接（可选）：不启动时仅本地使用，启动后 HTTP 长轮询连接控制平面
- Task 管理（`src/task/`）：node 侧独立管理 task 生命周期，与 ACP session 解耦（见第 4.6 节）

**Node 如何管理原生 agent**：原生 agent（`packages/agent` 产物）编译为独立可执行文件，Node 通过配置文件读取 binary 路径，spawn 为子进程，经 ACP stdio 通信。Node 不 import `@tianji/agent`，仅通过 ACP 协议交互，与第三方 agent 的管理方式完全一致。

**Agent 自主配置加载**：每个原生 agent 独立加载自身配置（provider 环境变量、模型参数等）。`SOUL.md` 由 agent 根据自身名称从标准路径（`~/.config/tianji-ai/agents/<agent-name>/SOUL.md`）加载，Node 不参与配置注入。

**Daemon 架构迁移**：V2 的 daemon 在进程内持有 `AgentSession`（直接 import `@tianji/agent`）。V3 中 daemon 改为通过 ACP subprocess 与 agent 通信，daemon 仅负责进程管理和 ACP 连接维护，不再直接依赖 `@tianji/agent` 或 `@tianji/runtime`。

**编译方案**：原生 agent 使用 Node.js SEA（Single Executable Application）或 esbuild bundle + Node runtime 分发。具体方案在实现阶段根据依赖打包复杂度确定，约束条件：必须支持 `@tianji/runtime` 的全部 Node API 调用，不依赖运行时解析 node_modules。

ACP 适配代码目前只有 `apps/node` 一个消费方，不提前抽成包；等出现第二个消费方时再提取。

**并发约束**：V3 单任务模型，每个 node 同一时刻只执行一个任务。Node 在心跳中上报 node-level 的 `executionState`（见 4.3 节），控制面基于该字段做调度决策。多任务并发（含单 node 多 agent 并行、agent 粒度状态上报）为 V4 问题。

**会话归属**：完整会话由 node 管理。controlplane 只保存 `task ↔ session` 引用关系、最新 `runId` 与 task 摘要，不持久化完整消息正文。

### 3.2 `apps/controlplane`

新增 Web 应用，职责：

- Node 注册与在线状态维护（含心跳超时推导 offline 状态）
- 长轮询端点（指令下发通道）
- REST API（Web UI 调用）
- 任务状态与事件日志持久化（有限保留，见第 4.4 节）
- SSE 推送（Web UI 实时展示）

不实现多租户，单一控制平面。

框架候选：Hono（原生支持长轮询 hold、SSE helper、轻量）、Fastify（成熟生态、streaming 支持好）。具体框架在实现阶段确定，约束：需支持长轮询（持有 HTTP 请求至超时）、SSE 推送、轻量持久化（SQLite 可接受）。

**框架选型验证清单**：无论选择哪个框架，实现阶段必须先验证以下能力，再开始业务逻辑开发：

1. 长轮询：持有 HTTP 请求 30s 后超时返回
2. NDJSON streaming：服务端持续接收 chunked POST body
3. SSE：支持 `last-event-id` 断线重连
4. SQLite 写入：高频追加写不阻塞读

若任一能力不满足，需在实现阶段第一周内确认替代方案。

---

## 4. Node ↔ 控制平面通信

### 4.1 为什么用长轮询

Node 位于 NAT / 防火墙后，**所有连接必须由 Node 主动向外发起**。长轮询满足这个前提，且：

- 标准 HTTP，企业代理和部分云环境会拦截 WebSocket `Upgrade`，穿透性更好
- 实现更简单，不需要维护连接状态机
- 未来可在同一端点升级为 WebSocket，Node 侧接口语义不变

### 4.2 Node 身份与认证

**enrollmentToken**：控制平面管理员生成的注册令牌，分发给设备运维人员写入 node 配置文件。该模型仅适用于**受信内网**场景，不适用于公网多租户部署。

Node 首次启动时本地生成 UUID 作为 `nodeId` 并持久化，后续复用。

**认证流程（PSK + 长期 token）**：

1. Node 携带 `enrollmentToken` 和本地持久化的 `nodeId` 向控制平面注册
2. 控制平面验证 `enrollmentToken`，检查 `nodeId`：
   - 若 `nodeId` 不存在：首次注册，签发 `accessToken` 返回
   - 若 `nodeId` 已存在：视为 re-enroll，签发新 `accessToken` 返回（旧 token 失效）。心跳机制自然接管在线状态检测
3. 注册成功返回 `accessToken`（90 天有效期），node 持久化到本地配置（`~/.config/tianji-ai/node/access-token`）
4. Node 使用 `accessToken` 访问所有 API 端点
5. 控制面将 token 持久化到 SQLite，重启后 token 仍有效，node 无需重新注册
6. Token 过期或被吊销后，node 收到 401，携带 `enrollmentToken` 重新注册
7. 管理员可在控制面手动 revoke 指定 node 的 token

> **设备重装场景**：若设备重装导致 `accessToken` 丢失，node 携带 `enrollmentToken` + 新 `nodeId` 重新注册即可。管理员可选择在控制面清理旧 node 记录。

### 4.3 端点约定

#### 对象关系

| 对象 | 生成方 | 核心字段 | 说明 |
|------|--------|----------|------|
| `Task` | controlplane | `taskId`, `nodeId`, `agentId`, `goal`, `status` | 长期工作对象 |
| `Session` | node | `sessionId`, `nodeId`, `agentId` | 完整对话容器 |
| `Run` | runtime | `runId`, `sessionId` | 单次 turn 执行 |

关系：

1. 用户可直接创建 `session`，不必先创建 `task`
2. `task` 可在执行前、执行中或执行后关联一个或多个 `session`
3. 一个 `session` 可被多个 `task` 复用
4. 若 `sessionId` 不属于目标 node，controlplane 不允许将该 session 关联到 task

**注册**（Node 启动时一次）：

```
POST /api/nodes/register
Body: { nodeId, enrollmentToken, hostname, platform, version, agentList[] }
Response: { accessToken, expiresAt }
```

agentList 元素结构（注册时必传，心跳中可选——仅在本地 agent 配置变更时携带全量快照，控制面收到后**整体覆盖**旧列表，未携带时沿用上次已知列表）：

```typescript
{
  agentId: string;           // 稳定标识，本地配置生成
  type: "native" | "third-party";
  name: string;
  version: string;
}
```

**心跳**（每 30s）：

```
POST /api/nodes/:nodeId/heartbeat
Authorization: Bearer <accessToken>
Body: { executionState, agentList? }
Response: 204
```

`executionState`：node-level 执行状态，`"idle"` 或 `"busy"`。控制面基于该字段做调度决策（见 4.5 节）。Node 有任何 task 处于 running 时上报 `"busy"`，否则上报 `"idle"`。

> **时钟说明**：控制面的 online/offline 判断**仅基于服务端接收心跳的时间戳**，不使用 node 上报的任何时间字段。
>
> **Agent 粒度状态**：V3 不上报各 agent 的独立状态（idle/busy/error），node 级 `executionState` 已充分表达单任务模型下的执行状态。当前执行的 agent 信息从 task 的 command payload 中获取。Agent 粒度状态上报为 V4 多任务并发时的扩展点。

**长轮询取指令**（Node 持续循环）：

```
GET /api/nodes/:nodeId/commands/poll?timeout=30000
Authorization: Bearer <accessToken>

- 控制平面持有请求，有指令时立即返回并同步将 command 置为 leased
- 无指令时超时返回 204，Node 立即重新发起，不等待
- 有指令时返回: { commandId, type, payload }
```

`task.run` payload：

```typescript
{
  taskId: string
  agentId: string
  goal: string
  sessionIds?: string[]   // 可选已有会话引用；缺失表示 agent 自行创建/选择 session
}
```

poll 返回即视为 leased，无需额外 ack 端点。

**事件上报**（任务执行期间流式上报）：

```
POST /api/tasks/:taskId/events
Authorization: Bearer <accessToken>
Content-Type: application/x-ndjson
Body: 每行一个 TaskEvent JSON（见第 4.6 节）
```

**NDJSON 连接可靠性策略**：

- **Keepalive**：Node 每 20s 发送一个空行（`\n`）作为 keepalive，防止中间代理因 idle 超时切断连接
- **服务端超时**：控制面 60s 内未收到任何数据（含 keepalive 空行）时，视为连接中断
- **Node 侧缓冲**：Node 在内存中维护环形缓冲区（最近 500 条事件）。NDJSON 连接中断后，Node 重建连接并从缓冲区起点重发。控制面通过 `taskId + sequence` 去重，相同组合的事件只存储一次
- **重连退避**：连接中断后立即重试，失败则 1s → 2s → 4s → 8s → 15s 指数退避，上限 15s

Node 必须在关闭连接前发送 `task.completed` 或 `task.failed` lifecycle 事件。若连接中断时无终态事件，控制面按照 observation_lost 规则处理（见 4.5 节）。

### 4.4 事件持久化策略

控制面提供的是**任务事件缓存**，不是完整会话存储，也不是完整审计日志：

- 以 node 上报的 `taskId + sequence` 为权威逻辑顺序，用于去重、排序和 SSE 断线重连
- 控制面额外记录 `receivedAt` 服务端时间戳，仅用于运维监控，不参与事件排序
- 通过 `taskId + sequence` 去重，防止 NDJSON 重连时的重复写入
- 单任务上限：10 MB 或 7 天，超出后截断旧事件，UI 展示截断提示
- SSE 断线重连：`last-event-id` 格式为 `taskId:sequence`，断线重连时从该 sequence 之后补发
- V3 不提供 controlplane 本地完整会话下载

**完整聊天内容读取路径**：

| 场景 | 数据来源 | 说明 |
|------|----------|------|
| 节点/任务列表 | controlplane | 只读 task 元数据与事件缓存 |
| 任务详情（在线） | controlplane + node | controlplane 返回 task 与关联 session 元数据，并代理到 node 拉完整 `session` |
| 任务详情（node 离线） | controlplane | 仅展示缓存的事件与摘要，标记“完整会话暂不可用” |
| 直接聊天详情（在线） | controlplane + node | controlplane 代理到 node 读取指定 `session` |

**锚点事件策略**：截断旧事件时，所有 `kind: "lifecycle"` 的事件必须保留，不受 10 MB / 7 天限制：

- `task.started` lifecycle 事件（含初始上下文）
- `task.completed` / `task.failed` 终态 lifecycle 事件

截断仅移除 `kind: "agent"` 的事件，从最旧的开始。UI 展示截断提示并标注被截断的 sequence 范围。

### 4.5 Task 状态机

```
pending ──→ running ──→ waiting ──→ running
   │           │   ↘ completed
   │           │   ↘ failed
   │           │   ↘ cancelled
   │           │   ↘ observation_lost
   └───────────┴──────────────────────────────
```

各状态说明：

- **pending**：task 已创建，尚未被 node/agent 接手
- **running**：task 正在被 agent 推进；期间可创建或复用多个 `session`，并产生多个 `run`
- **waiting**：task 当前不在主动执行，等待用户输入、外部资源、定时触发或后续调度
- **completed / failed / cancelled**：确定性终态
- **observation_lost**：控制面失去对 task 的观测，task 真实状态不确定。以下任一条件触发：
  - task 处于 `running` 或 `waiting`，且对应 node 因心跳超时被标记为 `offline`
  - task 处于 `running`，且 NDJSON 连接中断后 **5 分钟**内无新的 task 级事件
- **observation_lost 终态补发**：
  - `observation_lost` 后如果 node 重连并补发新的 task 终态事件，只要 sequence 合法，控制面接受并覆盖为对应终态
  - 事件保留期（7 天）过后，`observation_lost` 成为不可逆终态，不再接受补发
  - UI 通过 `failureReason` 字段区分：`"observation_lost"` / `"agent_error"` / `"cancelled_by_user"`

**调度约束（单任务模型）**：控制面 poll 端点在返回 command 前，检查该 node 最近一次心跳上报的 `executionState`：若为 `"busy"`，即使存在 pending task 也返回 204，不下发。这保证了 V3 每个 node 同一时刻只有一个 active task。`waiting` task 不占用 node 执行槽位，但仍归属于该 node。

**崩溃恢复**：Node 侧维护轻量状态文件（`~/.config/tianji-ai/node/current_command`）记录当前 active task command：

- poll 拿到 command 后，先将 `commandId` 持久化到状态文件，再启动执行
- Node 崩溃恢复后若发现未完成的 commandId，上报 task 级异常事件，并将 task 置为 `waiting` 或 `failed`，由 agent 决定是否可恢复
- 控制面 lease 机制覆盖正常场景的重复投递

### 4.6 Task 与 RuntimeEvent 的关系

**Task 是 controlplane 管理的长期工作对象**，不是 runtime 原生概念。runtime 原生概念仍是 `session` / `run`：

- Task 代表用户委托给 node/agent 的目标；agent 可基于 langgraph 在多个 `session` / `run` 间编排推进
- `session` 表示完整会话容器，可独立存在，也可被 task 引用
- `run` 表示某个 session 内一次实际执行，是 runtime 层原生对象
- Node 内部独立管理 task 生命周期；task 可绑定多个 `sessionId` 与多个 `runId`
- Node 与 agent 之间**始终通过 ACP 协议通信**（`ClientSideConnection` ↔ `AgentSideConnection`），不直接调用 runtime

**事件分层**：

| 层级 | 作用 |
|------|------|
| `TaskEvent` | 表达 task 生命周期、等待状态、session 关联、结果摘要 |
| `RuntimeEvent` | 表达某个 run 的流式执行细节 |

**TaskEvent 结构**（NDJSON 流中每行一个）：

```typescript
type TaskEvent = TaskLifecycleEvent | TaskAgentEvent

/** Node 生成的 task 生命周期事件 */
interface TaskLifecycleEvent {
  kind: "lifecycle"
  taskId: string
  type:
    | "task.started"
    | "task.waiting"
    | "task.completed"
    | "task.failed"
    | "task.cancelled"
    | "task.session.attached"
  sequence: number         // 单调递增，用于去重和排序
  timestamp: number        // unix ms
  sessionId?: string
  runId?: string
  summary?: string
  error?: string           // task.failed 时携带
}

/** Agent 产出的 RuntimeEvent（透传） */
interface TaskAgentEvent {
  kind: "agent"
  taskId: string
  sequence: number         // 与 lifecycle 事件共享同一递增序列
  sessionId: string
  runId: string
  event: RuntimeEvent      // 原样透传，不修改
}
```

**映射关系**（agent 类型 task）：

- Node 通过 ACP `ClientSideConnection` 与 agent 通信
- Agent 的 ACP session/update 事件由 node 映射为 `AsyncIterable<RuntimeEvent>`
- agent 可在执行 task 期间创建或复用多个 `session`
- 每当 task 首次引用某个 `session`，node 上报 `task.session.attached`
- task 进入活跃执行时，上报 `task.started`
- task 暂停等待外部条件时，上报 `task.waiting`
- task 结束时，上报 `task.completed` / `task.failed` / `task.cancelled`
- 所有 `RuntimeEvent` 同时作为 `TaskAgentEvent` 透传给控制面，并显式带上 `sessionId + runId`

---

## 5. 数据流

### 5.1 用户通过控制平面下发任务

```
1. 用户在 Web UI 选择 Node + Agent，输入 task goal，可选关联已有 `sessionIds`
2. 控制平面校验：所有 `sessionIds` 必须属于目标 node
3. 控制平面创建 taskId，写入 pending command：{ commandId, type: "task.run", taskId, agentId, goal, sessionIds? }
4. Node 长轮询命中，取到 command
5. 控制平面同步将 command 标记为 leased（记录 leased_at）
6. Node 将 commandId 持久化到 current_command 状态文件
7. Agent 基于 langgraph 决定是新建 session、复用已有 session，还是在多个 session 间切换
8. 每次 task 绑定新 session 时，node 上报 `task.session.attached`
9. Agent 在一个或多个 session 中发起 run
10. Node 将 ACP 事件映射为 AsyncIterable<RuntimeEvent>`，并包装为带 `taskId + sessionId + runId` 的 `TaskAgentEvent`
11. task 进入执行时上报 `task.started`；等待用户或外部条件时上报 `task.waiting`
12. 控制平面通过 SSE 推送给 Web UI 实时展示
13. task 最终完成、失败或取消时，上报终态 lifecycle 事件，控制面更新 task 终态
14. Node 清除 current_command 状态文件
```

### 5.2 用户直接聊天

```
1. 用户在 Web UI 选择 `node + agent`
2. 控制平面创建或打开一个 `session`
3. 浏览器通过 controlplane 代理与 node 上的该 `session` 交互
4. 完整消息历史始终保存在 node 本地
5. 后续用户可将该 `session` 关联到某个 task
```

### 5.3 完整聊天内容读取

```text
Browser
  → Control Plane `/api/tasks/:taskId`
    → 返回 task 元数据、关联 session 列表、最新 run 摘要
  → Control Plane `/api/tasks/:taskId/messages`
    → 若 node 在线：Control Plane 代理到 Node 读取关联 sessions 的完整内容
    → 若 node 离线：返回事件缓存与降级标记

Browser
  → Control Plane `/api/ui/sessions/:sessionId/messages`
    → 若 node 在线：代理到 Node 读取完整 session
    → 若 node 离线：返回不可用
```

### 5.4 本地 CLI 使用（不连控制平面）

```
用户执行 tianji run "prompt"
  → Node 本地模式（无需控制平面连接）
  → 同一套 ACP 调用路径（spawn agent subprocess，ACP stdio 通信）
  → RuntimeEvent 直接渲染到终端
```

两种模式共享同一套 ACP 调用路径，差异只在事件的消费方（终端 vs 控制平面）。

---

## 6. 依赖矩阵

| 包 / App | 允许的内部依赖 | 关键外部依赖 | 禁止 |
|----------|--------------|------------|------|
| `@tianji/shared` | 无 | `zod` | 所有内部包 |
| `@tianji/observer` | 无 | `@opentelemetry/api` | 所有内部包 |
| `@tianji/runtime` | `shared` | `ai`, `@ai-sdk/*`, `deepagents` | `agent`, `apps/*` |
| `@tianji/agent` | `shared`, `runtime`, `observer` | `zod`（可选） | `apps/*` |
| `apps/node` | `shared`, `observer` | `@agentclientprotocol/sdk`, `@types/node` | `runtime`, `agent`, AI SDK |
| `apps/controlplane` | `shared`, `observer` | Web 框架（TBD） | `runtime`, `agent` |

> `RuntimeEvent` 类型定义在 `@tianji/shared`，`runtime` 和 `apps/node` 均从 `shared` 取，避免 `apps/node` 间接依赖 `runtime`。
>
> `apps/node` 不 import `@tianji/agent`，原生 agent 以独立进程运行，通过 ACP stdio 通信，管理方式与第三方 agent 一致。
>
> `@tianji/observer` 被 node 和 controlplane 分别依赖，各自配置独立的日志文件路径（node: `~/.config/tianji-ai/logs/node.log`，controlplane: `<data-dir>/logs/controlplane.log`）。

---

## 7. 非目标

- 不实现 WebSocket 升级（接口已预留，V4 实现）
- 不实现多租户（enrollmentToken 模型仅适用受信内网）
- 不实现 ACP 远程 transport（HTTP/WebSocket 模式，ACP 规范尚未定稿）
- 不改变 V2 各包的内部实现
- 不实现任务取消、控制平面侧超时（V3 仅支持 fire-and-stream）
- 不支持多任务并发（V3 单 node 单任务，V4 扩展）
- 不提供完整审计日志（事件存储为有限保留缓存，最多 10 MB / 7 天）
- 不实现 node 侧完整磁盘幂等表（仅维护 current_command 状态文件用于崩溃恢复去重，不做全量 command 历史记录）
- 不实现 command 自动重试（leased 超时直接 failed，用户手动重新下发）
- 不实现 agent 粒度状态上报（V4 多任务并发时扩展）
- 不实现 token 轮换与 refresh 机制（受信内网使用长期 token，V4 公网部署时升级认证体系）
- 不实现 Web UI 认证（受信内网，无需登录）

---

## 8. Web UI API

### 8.1 概览

浏览器端点使用 `/api/ui/...` 前缀，与 node 端点（`/api/nodes/...`、`/api/tasks/:taskId/events`）明确区分。

| Method | Path | 用途 |
|--------|------|------|
| GET | `/api/ui/nodes` | 节点列表 |
| POST | `/api/ui/sessions` | 直接聊天：创建会话 |
| GET | `/api/ui/sessions` | 会话列表 |
| GET | `/api/ui/sessions/:sessionId` | 会话详情 |
| GET | `/api/ui/sessions/:sessionId/messages` | 完整会话消息 |
| POST | `/api/ui/tasks` | 创建任务 |
| GET | `/api/ui/tasks` | 任务列表 |
| GET | `/api/ui/tasks/:taskId` | 任务详情 |
| GET | `/api/ui/tasks/:taskId/events` | 任务事件历史 |
| GET | `/api/ui/tasks/:taskId/stream` | SSE 实时推送 |
| GET | `/api/ui/tasks/:taskId/messages` | 完整聊天内容 |

### 8.2 节点列表

```
GET /api/ui/nodes

Response 200:
[
  {
    "nodeId": "uuid",
    "hostname": "dev-machine-1",
    "platform": "linux",
    "version": "3.0.0",
    "status": "online",
    "executionState": "idle",
    "lastHeartbeatAt": 1743638400000,
    "agents": [
      { "agentId": "default", "type": "native", "name": "default", "version": "3.0.0" },
      { "agentId": "claude-code", "type": "third-party", "name": "Claude Code", "version": "1.0.0" }
    ]
  }
]
```

`status` 由 controlplane 根据 `lastHeartbeatAt` 推导（超过 90s 无心跳则 `"offline"`）。`agents` 来自最近一次注册或心跳携带的 `agentList`。

### 8.3 创建任务

```
POST /api/ui/tasks
Content-Type: application/json

Body:
{
  "nodeId": "uuid",
  "agentId": "default",
  "goal": "重构 src/runtime.ts 中的重试逻辑",
  "sessionIds": ["uuid-a", "uuid-b"]   // 可选，关联已有 session
}

Response 201:
{
  "taskId": "uuid",
  "commandId": "uuid",
  "status": "pending",
  "createdAt": 1743638400000
}
```

业务规则：

- controlplane 创建 task 记录和 pending command，等待 node 长轮询取走
- 若指定 `sessionIds`，controlplane 校验所有 session 必须属于目标 node，否则返回 `400`
- 若 node 状态为 `offline`，返回 `409 Conflict`

### 8.4 创建会话（直接聊天）

```
POST /api/ui/sessions
Content-Type: application/json

Body:
{
  "nodeId": "uuid",
  "agentId": "default",
  "title": "runtime 重构讨论"   // 可选
}

Response 201:
{
  "sessionId": "uuid",
  "nodeId": "uuid",
  "agentId": "default",
  "createdAt": 1743638400000
}
```

controlplane 只创建 session 元数据并将请求代理到 node。完整消息历史仍由 node 持久化。

### 8.5 会话列表

```
GET /api/ui/sessions?nodeId=uuid&agentId=default&limit=50&cursor=sessionId

Response 200:
{
  "items": [
    {
      "sessionId": "uuid",
      "nodeId": "uuid",
      "agentId": "default",
      "title": "runtime 重构讨论",
      "lastRunAt": 1743638401000,
      "linkedTaskCount": 2,
      "createdAt": 1743638400000,
      "updatedAt": 1743638401000
    }
  ],
  "nextCursor": "sessionId" | null
}
```

### 8.6 任务列表

```
GET /api/ui/tasks?nodeId=uuid&status=running&limit=50&cursor=taskId

Response 200:
{
  "items": [
    {
      "taskId": "uuid",
      "nodeId": "uuid",
      "agentId": "default",
      "goal": "重构 src/runtime.ts 中的重试逻辑",
      "sessionIds": ["uuid-a", "uuid-b"],
      "latestRunId": "uuid-run-1",
      "status": "running",
      "failureReason": null,
      "createdAt": 1743638400000,
      "updatedAt": 1743638401000
    }
  ],
  "nextCursor": "taskId" | null
}
```

支持按 `nodeId` 和 `status` 过滤。`cursor` 分页基于 `taskId` 排序，`limit` 默认 50，最大 100。

### 8.7 任务详情

```
GET /api/ui/tasks/:taskId

Response 200:
{
  "taskId": "uuid",
  "commandId": "uuid",
  "nodeId": "uuid",
  "agentId": "default",
  "goal": "重构 src/runtime.ts 中的重试逻辑",
  "sessionIds": ["uuid-a", "uuid-b"],
  "latestRunId": "uuid-run-2",
  "status": "completed",
  "failureReason": null,
  "summary": "已完成重构并补充回归测试",
  "createdAt": 1743638400000,
  "updatedAt": 1743638402000
}

Response 404: task 不存在
```

### 8.8 会话详情

```
GET /api/ui/sessions/:sessionId

Response 200:
{
  "sessionId": "uuid",
  "nodeId": "uuid",
  "agentId": "default",
  "title": "runtime 重构讨论",
  "linkedTaskIds": ["task-a", "task-b"],
  "lastRunId": "run-1",
  "createdAt": 1743638400000,
  "updatedAt": 1743638402000
}
```

### 8.9 任务事件历史

```
GET /api/ui/tasks/:taskId/events?after=0&limit=200

Response 200:
{
  "items": [
    {
      "sequence": 1,
      "kind": "lifecycle",
      "payload": {
        "type": "task.started",
        "taskId": "...",
        "summary": "开始分析现有实现",
        "timestamp": 1743638400000
      },
      "receivedAt": 1743638400100
    },
    {
      "sequence": 2,
      "kind": "agent",
      "payload": {
        "sessionId": "...",
        "runId": "...",
        "type": "message.delta",
        "messageId": "...",
        "sequence": 0,
        "channel": "text",
        "payload": { "content": "你好" },
        "timestamp": 1743638400200
      },
      "receivedAt": 1743638400250
    }
  ],
  "nextSequence": 15,
  "truncated": false
}
```

`after` 为 sequence 值，返回大于该 sequence 的事件。`truncated` 为 `true` 表示早期 agent 事件已被截断。此端点同时用于 SSE 断线重连时的 catch-up。

### 8.10 SSE 实时推送

```
GET /api/ui/tasks/:taskId/stream
Accept: text/event-stream
Last-Event-ID: {taskId}:{sequence}    // 可选，断线重连时自动携带

Response: text/event-stream

event: task.lifecycle
id: {taskId}:1
data: {"sequence":1,"kind":"lifecycle","payload":{"type":"task.started","taskId":"...","summary":"开始分析现有实现","timestamp":1743638400000}}

event: task.lifecycle
id: {taskId}:2
data: {"sequence":2,"kind":"lifecycle","payload":{"type":"task.session.attached","taskId":"...","sessionId":"session-a","summary":"关联现有 coding session","timestamp":1743638400050}}

event: agent.message.delta
id: {taskId}:3
data: {"sequence":3,"kind":"agent","payload":{"sessionId":"session-a","runId":"run-a1","type":"message.delta","messageId":"...","sequence":0,"channel":"text","payload":{"content":"你好"},"timestamp":1743638400100}}

event: agent.tool.started
id: {taskId}:6
data: {"sequence":6,"kind":"agent","payload":{"sessionId":"session-a","runId":"run-a1","type":"tool.started","toolCallId":"...","invocation":{"toolCallId":"...","toolName":"read_file","args":{"path":"src/main.ts"}},"timestamp":1743638400300}}

event: task.lifecycle
id: {taskId}:8
data: {"sequence":8,"kind":"lifecycle","payload":{"type":"task.waiting","taskId":"...","summary":"等待用户确认重构方案","timestamp":1743638400800}}

event: task.lifecycle
id: {taskId}:10
data: {"sequence":10,"kind":"lifecycle","payload":{"type":"task.completed","taskId":"...","summary":"重构完成并已验证","timestamp":1743638401000}}
```

**SSE event type 命名规则**：

| TaskEvent kind | RuntimeEvent type | SSE event type |
|----------------|-------------------|----------------|
| `lifecycle` | — | `task.lifecycle` |
| `agent` | `run.started` | `agent.run.started` |
| `agent` | `run.completed` | `agent.run.completed` |
| `agent` | `run.failed` | `agent.run.failed` |
| `agent` | `run.cancelled` | `agent.run.cancelled` |
| `agent` | `message.started` | `agent.message.started` |
| `agent` | `message.delta` | `agent.message.delta` |
| `agent` | `message.completed` | `agent.message.completed` |
| `agent` | `tool.started` | `agent.tool.started` |
| `agent` | `tool.completed` | `agent.tool.completed` |
| `agent` | `tool.failed` | `agent.tool.failed` |

SSE `id` 格式为 `{taskId}:{sequence}`，与第 4.4 节一致。

**断线重连**：浏览器原生 `EventSource` 断线后自动携带 `Last-Event-ID`。controlplane 从 `task_events` 表查询 `sequence > lastSequence` 的事件按序补发。task 已终结时，补发剩余事件后发送 `event: done` 并关闭连接。

**心跳**：controlplane 每 15s 发送 SSE comment（`: keepalive\n\n`）防止浏览器超时断连。

### 8.11 完整聊天内容

```
GET /api/ui/tasks/:taskId/messages

Response 200（node 在线）:
{
  "source": "node",
  "sessions": [
    {
      "sessionId": "session-a",
      "messages": [
        {
          "id": "msg-1",
          "role": "user",
          "content": [{ "type": "text", "text": "先分析 runtime.ts 的重试逻辑" }],
          "createdAt": 1743638400000
        },
        {
          "id": "msg-2",
          "role": "assistant",
          "content": [{ "type": "text", "text": "好的，我先查看现有实现..." }],
          "createdAt": 1743638401000
        }
      ]
    }
  ]
}

Response 200（node 离线）:
{
  "source": "cache",
  "degraded": true,
  "events": [ ... ]
}
```

controlplane 代理请求到 node 获取 task 关联的完整 session messages。node 离线时降级返回事件缓存，格式同 `/events` 端点。前端根据 `source` 字段决定渲染方式。

### 8.12 会话消息

```
GET /api/ui/sessions/:sessionId/messages

Response 200:
{
  "source": "node",
  "sessionId": "session-a",
  "messages": [ ... ]
}
```

---

## 9. 数据库 Schema

SQLite，启用 WAL 模式（`PRAGMA journal_mode=WAL`）。所有时间字段为 unix 毫秒（`INTEGER`）。

### 9.1 enrollment_tokens

```sql
CREATE TABLE enrollment_tokens (
  token       TEXT    PRIMARY KEY,
  created_at  INTEGER NOT NULL
);
```

V3 允许同一 token 注册多个 node。管理员通过 CLI 子命令生成 token。

### 9.2 nodes

```sql
CREATE TABLE nodes (
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
```

`access_token_hash` 存储 SHA-256 hash，不存明文。`status` 由心跳超时推导（惰性计算或定时扫描，阈值 90s）。`execution_state` 跟随心跳更新。

### 9.3 agents

```sql
CREATE TABLE agents (
  node_id    TEXT    NOT NULL REFERENCES nodes(node_id),
  agent_id   TEXT    NOT NULL,
  type       TEXT    NOT NULL CHECK(type IN ('native', 'third-party')),
  name       TEXT    NOT NULL,
  version    TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, agent_id)
);
```

每次 node 注册或心跳携带 `agentList` 时，先 `DELETE FROM agents WHERE node_id = ?` 再 `INSERT` 全量，实现整体覆盖语义。

### 9.4 commands

```sql
CREATE TABLE commands (
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

CREATE INDEX idx_commands_node_state ON commands(node_id, state);
```

V3 约定 `task.run` payload 为：`{ "taskId": "...", "agentId": "...", "goal": "...", "sessionIds?": ["..."] }`。

### 9.5 tasks

```sql
CREATE TABLE tasks (
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

CREATE INDEX idx_tasks_node      ON tasks(node_id, created_at DESC);
CREATE INDEX idx_tasks_status    ON tasks(status);
```

`latest_run_id` 跟随最新一次 runtime run 更新。`failure_reason` 取值：`"agent_error"` / `"cancelled_by_user"` / `"observation_lost"`。

`tasks.status` 与当前 active `commands.state` 在同一 SQLite 事务中同步更新（1 task 对应 1 次当前调度 command，但 task 生命周期可长于单次执行）。

### 9.6 sessions

```sql
CREATE TABLE sessions (
  session_id     TEXT    PRIMARY KEY,
  node_id        TEXT    NOT NULL REFERENCES nodes(node_id),
  agent_id       TEXT    NOT NULL,
  title          TEXT,
  created_by     TEXT    NOT NULL CHECK(created_by IN ('user', 'task')),
  last_run_id    TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX idx_sessions_node   ON sessions(node_id, updated_at DESC);
CREATE INDEX idx_sessions_agent  ON sessions(node_id, agent_id, updated_at DESC);
```

### 9.7 task_sessions

```sql
CREATE TABLE task_sessions (
  task_id        TEXT    NOT NULL REFERENCES tasks(task_id),
  session_id     TEXT    NOT NULL REFERENCES sessions(session_id),
  attached_at    INTEGER NOT NULL,
  attached_by    TEXT    NOT NULL CHECK(attached_by IN ('user', 'agent')),
  PRIMARY KEY (task_id, session_id)
);

CREATE INDEX idx_task_sessions_session ON task_sessions(session_id, attached_at DESC);
```

### 9.8 task_events

```sql
CREATE TABLE task_events (
  task_id     TEXT    NOT NULL REFERENCES tasks(task_id),
  sequence    INTEGER NOT NULL,
  kind        TEXT    NOT NULL CHECK(kind IN ('lifecycle', 'agent')),
  payload     TEXT    NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, sequence)
);
```

`PRIMARY KEY (task_id, sequence)` 天然去重——node 重连重发时 `INSERT OR IGNORE` 跳过。`payload` 为 JSON 字符串，存储 `TaskLifecycleEvent` 或 `TaskAgentEvent` 的 payload 部分（`taskId`/`sequence`/`kind` 已在列中，不重复存储）。

**截断策略**：写入时检查单任务事件总大小（`SUM(LENGTH(payload))`），超 10 MB 时删除最旧的 `kind = 'agent'` 事件，保留所有 `kind = 'lifecycle'`。

### 9.9 索引说明

| 索引 | 用途 |
|------|------|
| `idx_commands_node_state` | 长轮询 poll 查询 pending command |
| `idx_tasks_node` | 按 node 查任务列表 |
| `idx_tasks_status` | 按状态过滤任务 |
| `idx_sessions_node` | 按 node 查会话列表 |
| `idx_sessions_agent` | 按 agent 过滤会话 |
| `idx_task_sessions_session` | 查 session 关联了哪些 task |
| `task_events PK` | 去重 + 范围查询（SSE 断线重连） |

---

## 10. 部署与配置

### 10.1 决策表

| 决策项 | 结论 | 说明 |
|--------|------|------|
| Web UI 认证 | 不做 | 受信内网部署，不加认证中间件，V4 公网部署时补充 |
| 前端技术栈 | Vite + React + TanStack Router + TanStack Query | 内嵌 SPA，构建产物由 controlplane serve |
| 查询层 | `better-sqlite3` | 最小依赖，V3 表结构简单，不用 ORM |
| enrollmentToken 生成 | CLI 子命令 | `crypto.randomBytes(32).toString('base64url')` |
| accessToken 生成 | 注册时签发 | `crypto.randomBytes(32).toString('base64url')`，controlplane 存 SHA-256 hash |
| 在线/离线判定 | `now - lastHeartbeatAt > 90s` | 3 个心跳周期（30s x 3），惰性计算或定时扫描 |

### 10.2 启动配置

controlplane 通过环境变量配置，无配置文件：

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `TIANJI_CP_PORT` | `7800` | HTTP 监听端口 |
| `TIANJI_CP_HOST` | `0.0.0.0` | 监听地址 |
| `TIANJI_CP_DATA_DIR` | `~/.config/tianji-ai/controlplane` | 数据目录 |

数据目录结构：

```
<TIANJI_CP_DATA_DIR>/
├── controlplane.db              # SQLite 数据库（WAL 模式）
└── logs/
    └── controlplane.log
```

### 10.3 前端构建与 serve

```
apps/controlplane/
├── src/
│   ├── server/                  # 服务端
│   │   ├── index.ts             # 入口
│   │   ├── routes/
│   │   │   ├── ui.ts            # /api/ui/* 浏览器端点
│   │   │   ├── nodes.ts         # /api/nodes/* node 端点
│   │   │   └── tasks.ts         # /api/tasks/* node 事件上报
│   │   ├── db.ts                # better-sqlite3 初始化 + 建表迁移
│   │   └── sse.ts               # SSE 连接管理
│   └── web/                     # Vite + React SPA
│       ├── index.html
│       ├── main.tsx
│       ├── routes/
│       │   ├── index.tsx        # 节点列表页
│       │   ├── tasks.tsx        # 任务列表页
│       │   └── tasks.$taskId.tsx  # 聊天页
│       └── components/
│           ├── ChatView.tsx     # 聊天消息渲染
│           ├── ToolCallView.tsx # 工具调用展示
│           └── StreamingText.tsx # 流式文本
├── package.json
└── vite.config.ts
```

构建流程：`pnpm build` 先 `vite build`（产出 `dist/web/`），再 `tsup`/`esbuild` 编译服务端（产出 `dist/server/`）。生产模式下 serve `dist/web/` 静态文件，非 `/api/` 路径 fallback 到 `index.html`（SPA 路由）。

### 10.4 前端 Chat 渲染映射

前端 chat 视图消费 SSE 事件的行为映射：

| SSE event type | 前端行为 |
|----------------|---------|
| `task.lifecycle`（`task.started`） | 显示任务开始，记录 sessionId / runId |
| `agent.message.started` | 创建新消息气泡（assistant） |
| `agent.message.delta` | 流式追加文本（区分 `channel: "text"` 和 `"thinking"`） |
| `agent.message.completed` | 用完整 `message` 覆盖 delta 累积结果 |
| `agent.tool.started` | 显示工具调用卡片（执行中状态） |
| `agent.tool.completed` | 更新工具卡片（完成，展示 result 摘要） |
| `agent.tool.failed` | 更新工具卡片（失败，展示错误） |
| `task.lifecycle`（`task.completed`） | 显示任务完成，解锁输入框允许续聊 |
| `task.lifecycle`（`task.failed`） | 显示错误信息和 `failureReason` |

`message.delta` 高频特性要求前端做 debounced re-render（`useRef` + `requestAnimationFrame`），避免每个 delta 触发 React re-render。
