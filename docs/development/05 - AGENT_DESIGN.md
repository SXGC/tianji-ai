# Tianji AI Agent 设计文档

> 状态：当前
> 日期：2026-04-07
> 相关文档：[`01 - ARCHITECTURE.md`](./01%20-%20ARCHITECTURE.md)、[`03 - RUNTIME_DESIGN.md`](./03%20-%20RUNTIME_DESIGN.md)、[`02 - CONFIG_DESIGN.md`](./02%20-%20CONFIG_DESIGN.md)
> 范围：`@tianji/agent` 包的设计——上下文装配、provider 凭据注入、启动原语、daemon 协议、SOUL.md 加载、ACP 子系统。

---

## 1. 定位与职责

`@tianji/agent` 是 L2 编排层，位于 runtime 和 CLI 之间，承担配置到可执行会话的装配职责，并为后续编排能力提供稳定扩展点：

- 消除 CLI 对 runtime 创建细节的直接依赖，提供可复用的"配置到可执行 runtime"转换层
- 为多 agent 路由、规划器、agent 间通信提供独立扩展空间

具体职责：

| 职责 | 说明 |
|------|------|
| 上下文装配 | 将 `ResolvedConfig` 转化为可执行的 agent 上下文 |
| Provider 凭据注入 | 将配置中的 API key 注入 `process.env`（过渡桥接） |
| 启动原语 | 封装 `SessionRuntime` / `AgentSession` 的创建流程 |
| 首次运行初始化 | 创建用户配置目录、默认 agent、SOUL.md |
| Daemon 协议 | HTTP + SSE 的守护进程通信 |
| ACP 子系统 | 通过 stdin/stdout JSON-RPC 2.0 使 agent 可被外部宿主调度 |

---

## 2. 上下文加载

### 2.1 加载流程

```
loadAgentContext()
  → ensureDefaultUserConfig()     ← 首次运行初始化
  → loadResolvedConfig()          ← runtime 三层配置加载
  → getDefaultAgentDefinition()   ← 从配置中解析默认 agent
  → createLoadedAgentContext()    ← 内部辅助函数
      → parseAgentModelRef()      ← 解析 "openai:gpt-4" 为 provider + model
      → loadAgentSoul()           ← 读取 SOUL.md 内容
      → new FileSnapshotStore()   ← 创建快照存储
  → 返回 LoadedAgentContext
```

### 2.2 核心类型

```typescript
interface AgentAppPaths {
  readonly configDir: string         // ~/.config/tianji-ai
  readonly agentsDir: string         // ~/.config/tianji-ai/agents
  readonly logsDir: string           // ~/.config/tianji-ai/logs
  readonly configFilePath: string    // ~/.config/tianji-ai/tianji.json
  readonly cliLogFilePath: string    // ~/.config/tianji-ai/logs/tianji.log
  readonly daemonPortPath: string    // ~/.config/tianji-ai/daemon.port
  readonly daemonPidPath: string     // ~/.config/tianji-ai/daemon.pid
}

interface AgentContext {
  readonly agentName: string                          // e.g. 'default'
  readonly modelRef: string                           // e.g. 'openai:gpt-4'
  readonly provider: string                           // e.g. 'openai'
  readonly modelName: string                          // e.g. 'gpt-4'
  readonly providerConfig: TianjiProviderConfig | undefined
  readonly soulPath: string                           // SOUL.md 完整路径
  readonly soul: string                               // SOUL.md 文件内容
}

interface LoadedAgentContext {
  readonly paths: AgentAppPaths
  readonly config: TianjiConfig
  readonly agent: AgentContext
  readonly resolvedEnvVars: readonly string[]
  readonly snapshotStore: FileSnapshotStore
}
```

### 2.3 首次运行初始化

`ensureDefaultUserConfig()` 在首次运行时创建必要的目录和文件：

| 创建项 | 路径 | 条件 |
|-------|------|------|
| 配置目录 | `~/.config/tianji-ai/` | 不存在时 |
| agent 目录 | `~/.config/tianji-ai/agents/` | 不存在时 |
| 日志目录 | `~/.config/tianji-ai/logs/` | 不存在时 |
| 用户配置 | `~/.config/tianji-ai/tianji.json` | 不存在时，写入空 JSON |
| 默认 SOUL | `~/.config/tianji-ai/agents/{defaultAgent}/SOUL.md` | 不存在时（`defaultAgent` 取自 `config.agents.defaultAgent`，缺省为 `default`） |

---

## 3. SOUL.md 加载机制

### 3.1 路径解析

SOUL.md 路径由 `@tianji/shared` 的 `getAgentSoulPath()` 构建：

```
~/.config/tianji-ai/agents/{agentName}/SOUL.md
```

### 3.2 加载校验

`loadAgentSoul()`（由 `@tianji/shared` 提供）执行以下校验：

1. 文件存在性检查——不存在则抛出 `ENOENT`
2. 文件可读性检查——无权限则抛出
3. 读取 UTF-8 内容
4. 非空校验（trim 后不为空）——空内容则抛出

### 3.3 默认 SOUL 内容

```markdown
# Default Tianji Agent

You are the default Tianji agent.

- Be concise.
- Be direct.
- Be practical.
```

### 3.4 使用方式

SOUL.md 内容加载到 `AgentContext.soul`，在 `createAgentSession` 的 `query()` 调用中作为 `systemPrompt` 传给 `runtime.runTurn()`。可通过 `ChatOptions.systemPrompt` 覆盖。

---

## 4. Provider 凭据注入

### 4.1 设计定位

`injectProviderEnv()` 是当前实现中的兼容桥接。部分 provider SDK 仍依赖 `process.env` 中的标准环境变量名自动发现 API key，因此 agent 层在启动前统一完成注入；整体边界仍要求 runtime/llm 优先消费显式 provider 配置。

### 4.2 映射关系

| Provider | 环境变量 |
|----------|---------|
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` |

### 4.3 行为

1. 查找 agent 使用的 provider 对应的环境变量名
2. 从 `providerConfig.apiKey` 获取 API key 值
3. 仅当 key 非空字符串时注入 `process.env`
4. 未知 provider 静默跳过（不报错）

---

## 5. 启动原语

### 5.1 createAgentRuntime

```typescript
function createAgentRuntime(context: LoadedAgentContext): SessionRuntime
```

1. 调用 `injectProviderEnv()` 注入 API key
2. 从 context 构建 provider 配置（model、apiKey、baseUrl、headers）
3. 创建 `SessionRuntime` 实例，传入 snapshotStore 和 toolCatalog

模型标识符格式：`"provider:modelName"`（例如 `"openai:gpt-4.1"`）。

### 5.2 createAgentSession

```typescript
function createAgentSession(context: LoadedAgentContext): AgentSession
```

在 `createAgentRuntime` 之上封装会话级别的 API：

```typescript
interface AgentSession {
  readonly sessionId: SessionId
  readonly query: (prompt: string, options?: ChatOptions) => AsyncIterable<RuntimeEvent>
  readonly abort: () => void
}
```

`query()` 方法：
1. 在 runtime 上创建 session
2. 构造 user message
3. 调用 `runTurn()` 并追踪 `activeRunId`
4. 返回 `streamEvents()` 的 AsyncIterable
5. `finally` 块清理 `activeRunId`

`abort()` 方法：调用 `runtime.cancelRun(activeRunId)` 取消当前正在执行的 run。

Session ID 格式：`"session_{timestamp}"`。

---

## 6. Daemon 协议

### 6.1 架构概览

```
CLI ──HTTP──→ DaemonServer ──→ AgentSession
                    │
                    ├── GET /ping        → JSON
                    ├── POST /chat       → SSE stream
                    └── POST /shutdown   → JSON
```

Daemon 是一个绑定在 `127.0.0.1` 的 HTTP 服务，持有一个长生命周期的 `AgentSession`，通过端口文件和 PID 文件暴露自身状态。

### 6.2 HTTP 端点

#### GET /ping

返回 daemon 运行状态：

```json
{
  "sessionId": "session_1712000000000",
  "uptime": 3600,
  "pid": 1234,
  "controlPlane": {
    "enabled": false,
    "status": "disabled",
    "baseUrl": null,
    "lastSuccessAt": null,
    "lastError": null
  }
}
```

#### POST /chat

请求体：

```json
{
  "prompt": "What is 2+2?"
}
```

响应：`text/event-stream`（Server-Sent Events）

SSE 事件序列：

```
event: chat.event
data: {"type":"chat.event","event":{...RuntimeEvent...}}

event: chat.event
data: {"type":"chat.event","event":{...RuntimeEvent...}}

event: chat.done
data: {"type":"chat.done"}

```

错误响应：

```
event: chat.error
data: {"type":"chat.error","code":"BUSY","message":"A chat is already in progress"}

```

**并发控制**：同一时刻只允许一个 chat 请求。并发请求收到 `code: 'BUSY'` 错误。

#### POST /shutdown

触发优雅关闭：

```json
{
  "ok": true
}
```

关闭流程：等待活跃 chat 完成（20ms 轮询，10 秒超时上限） → 关闭 HTTP server → 删除端口/PID 文件。

### 6.3 SSE 编解码

#### 消息类型

```typescript
type ControlPlaneConnectionStatus = 'disabled' | 'connecting' | 'connected' | 'degraded'

interface ControlPlaneStatusSnapshot {
  readonly enabled: boolean
  readonly status: ControlPlaneConnectionStatus
  readonly baseUrl: string | null
  readonly lastSuccessAt: number | null
  readonly lastError: string | null
}

interface PingResponse {
  readonly sessionId: string
  readonly uptime: number
  readonly pid: number
  readonly controlPlane: ControlPlaneStatusSnapshot
}

interface ShutdownResponse {
  readonly ok: true
}

type ChatSseMessage =
  | { type: 'chat.event'; event: RuntimeEvent }   // 运行时事件
  | { type: 'chat.done' }                          // 对话结束
  | { type: 'chat.error'; code: 'BUSY' | 'INTERNAL'; message: string }
```

#### 编码格式

```typescript
function encodeSseMessage(input: { event: string; data: ChatSseMessage }): string
// 输出：`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
```

每条 SSE 消息由 `event:` 行、`data:` 行和空行分隔符组成。

#### 客户端解码

`DaemonClient.sendChat()` 实现逐行 SSE 解析：

1. 按 `\n` 分割数据流
2. `event:` 行记录事件类型
3. `data:` 行记录 JSON 载荷
4. 空行触发消息分发
5. `chat.event` → yield `RuntimeEvent`
6. `chat.done` → 停止迭代
7. `chat.error` → 抛出 Error

### 6.4 DaemonServer 构造选项

```typescript
interface DaemonServerOptions {
  readonly session: AgentSession
  readonly paths?: Pick<AgentAppPaths, 'daemonPortPath' | 'daemonPidPath'>
  readonly getControlPlaneStatus?: () => ControlPlaneStatusSnapshot
}
```

`getControlPlaneStatus` 回调用于在 `/ping` 响应中注入 Control Plane 连接状态。未提供时，使用 `DEFAULT_CONTROL_PLANE_STATUS`（`enabled: false`）。

### 6.5 状态文件

| 文件 | 内容 | 生命周期 |
|------|------|---------|
| `~/.config/tianji-ai/daemon.port` | 监听端口号（字符串） | server.listen → shutdown |
| `~/.config/tianji-ai/daemon.pid` | 进程 PID（字符串） | server.listen → shutdown |

CLI 通过读取端口文件来发现运行中的 daemon，通过 PID 文件判断进程是否存活。

### 6.6 关闭保证

`DaemonServer.shutdown()` 是幂等的——多次调用返回同一个 Promise。关闭步骤：

1. 等待活跃 chat 完成
2. 关闭 HTTP server
3. 删除 `daemon.port` 和 `daemon.pid`

---

## 7. 依赖约束

| 允许的外部依赖 | 允许的内部依赖 | 禁止依赖 |
|--------------|--------------|---------|
| `zod`（可选）、`@agentclientprotocol/sdk` | `@tianji/shared`, `@tianji/runtime` | `ai`, `@ai-sdk/*`, `@langchain/*`, Provider SDK, `apps/*` |

agent 包不直接使用任何 LLM 框架——它通过 runtime 的公共 API 间接使用。这确保 AI SDK / LangChain 的类型不会泄漏到上层。

`@agentclientprotocol/sdk` 用于 ACP（Agent Client Protocol）stdio 通信，使原生 agent 可作为 ACP agent 运行。构建产物通过 `esbuild` 打包为独立的 `acp-entry.js` 入口（`bin.tianji-agent`）。

---

## 8. 模块组织

```text
packages/agent/src/
├─ index.ts              # 公共导出
├─ context.ts            # 上下文装配、路径解析、首次初始化、凭据注入
├─ session.ts            # createAgentRuntime、createAgentSession
├─ daemon-protocol.ts    # SSE 常量、消息类型、Control Plane 类型、编码函数
├─ daemon-server.ts      # DaemonServer（HTTP + SSE）
├─ daemon-client.ts      # DaemonClient（HTTP + SSE 解析）
├─ acp-entry.ts          # ACP stdio 入口点（bin.tianji-agent）
└─ acp/                  # ACP 子模块
   ├─ index.ts           # 导出桶
   ├─ agent-bridge.ts    # TianjiAcpAgent — ACP 协议到 AgentSession 桥接
   └─ event-mapper.ts    # RuntimeEvent → ACP SessionUpdate 映射
```

---

## 9. ACP 子系统

### 9.1 设计定位

ACP（Agent Client Protocol）子模块使 tianji 原生 agent 可以作为独立进程运行，通过 stdin/stdout 进行 JSON-RPC 2.0 通信。这允许 tianji agent 被 ACP 兼容的宿主（如 IDE、编排器）以子进程方式调度。

### 9.2 入口点

`acp-entry.ts` 是 ACP 进程的入口（对应 `package.json` 中的 `bin.tianji-agent`）。启动流程：

```
runAcpAgent()
  → loadAgentContext()              ← 加载 agent 配置
  → ndJsonStream(stdout, stdin)     ← 建立 ndjson 双向流
  → new AgentSideConnection(...)    ← ACP SDK 连接管理
  → new TianjiAcpAgent(conn, sessionFactory)
  → await connection.closed         ← 等待连接关闭
```

`sessionFactory` 是 `() => createAgentSession(context)` 的惰性工厂，每次 ACP `newSession` 时创建独立的 `AgentSession` 实例。

### 9.3 协议桥接

`TianjiAcpAgent`（`acp/agent-bridge.ts`）实现 ACP 协议方法：

| 方法 | 行为 |
|------|------|
| `initialize()` | 返回 `protocolVersion` + `agentCapabilities: { loadSession: false }` |
| `newSession()` | 通过 `sessionFactory` 创建新 `AgentSession`，返回 `sessionId` |
| `authenticate()` | 空实现（返回 `{}`） |
| `prompt()` | 提取文本内容 → `session.query()` → 逐事件映射为 `SessionUpdate` 通知 → 返回 `stopReason` |
| `cancel()` | 中止当前 `prompt()` 执行 |

`prompt()` 的核心循环：

```
提取 prompt 文本 → 创建 AbortController
→ for await (event of session.query(text))
    → mapRuntimeEventToSessionUpdate(sessionId, event)
    → connection.sessionUpdate(update)    ← 推送到宿主
→ 返回 { stopReason: 'end_turn' }
```

### 9.4 事件映射

`mapRuntimeEventToSessionUpdate()`（`acp/event-mapper.ts`）将 `RuntimeEvent` 转换为 ACP `SessionNotification`：

| RuntimeEvent | ACP SessionUpdate | 说明 |
|-------------|-------------------|------|
| `message.delta` | `agent_message_chunk` 或 `agent_thought_chunk` | `channel === 'thinking'` 时为 thought |
| `tool.started` | `tool_call` | 包含 toolCallId、title、kind、status: pending |
| `tool.completed` | `tool_call_update` | status: completed |
| `tool.failed` | `tool_call_update` | status: failed |
| `message.started/completed`、`run.*` | 不映射（返回 null） | ACP prompt 返回值已隐含生命周期语义 |

工具名到 ACP `ToolKind` 的映射规则（`mapToolKind`）：

| 关键词 | ToolKind |
|-------|----------|
| `read`/`Read` | `read` |
| `edit`/`Edit`/`write` | `edit` |
| `exec`/`bash`/`shell` | `execute` |
| `search`/`grep`/`find` | `search` |
| 其他 | `other` |

### 9.5 公共导出

`index.ts` 导出 ACP 相关 API：

```typescript
export { TianjiAcpAgent, mapRuntimeEventToSessionUpdate } from './acp/index.js'
export { runAcpAgent } from './acp-entry.js'
```
