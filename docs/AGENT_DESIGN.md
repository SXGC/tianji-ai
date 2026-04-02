# Tianji AI Agent 设计文档

> 状态：当前
> 日期：2026-04-02
> 相关文档：[`./ARCHITECTURE.md`](./ARCHITECTURE.md)、[`./RUNTIME_DESIGN.md`](./RUNTIME_DESIGN.md)、[`./CONFIG_DESIGN.md`](./CONFIG_DESIGN.md)
> 范围：`@tianji/agent` 包的设计——上下文装配、provider 凭据注入、启动原语、daemon 协议、SOUL.md 加载。

---

## 1. 定位与职责

`@tianji/agent` 是 L2 编排层，位于 runtime 和 CLI 之间，解决两个问题：

- **当下**：消除 CLI 对 runtime 创建细节的直接依赖，提供可复用的"配置到可执行 runtime"的转换层
- **未来**：为多 agent 路由、规划器、agent 间通信提供独立扩展空间

具体职责：

| 职责 | 说明 |
|------|------|
| 上下文装配 | 将 `ResolvedConfig` 转化为可执行的 agent 上下文 |
| Provider 凭据注入 | 将配置中的 API key 注入 `process.env`（过渡桥接） |
| 启动原语 | 封装 `SessionRuntime` / `AgentSession` 的创建流程 |
| 首次运行初始化 | 创建用户配置目录、默认 agent、SOUL.md |
| Daemon 协议 | HTTP + SSE 的守护进程通信 |

---

## 2. 上下文加载

### 2.1 加载流程

```
loadAgentContext()
  → ensureDefaultUserConfig()     ← 首次运行初始化
  → loadResolvedConfig()          ← runtime 三层配置加载
  → getDefaultAgentDefinition()   ← 从配置中解析默认 agent
  → parseAgentModelRef()          ← 解析 "openai:gpt-4" 为 provider + model
  → loadAgentSoul()               ← 读取 SOUL.md 内容
  → new FileSnapshotStore()       ← 创建快照存储
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
| 默认 SOUL | `~/.config/tianji-ai/agents/default/SOUL.md` | 不存在时 |

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

SOUL.md 内容加载到 `AgentContext.soul`，在 `createAgentSession` 的 `chat()` 调用中作为 `systemPrompt` 传给 `runtime.runTurn()`。可通过 `ChatOptions.systemPrompt` 覆盖。

---

## 4. Provider 凭据注入

### 4.1 设计定位

`injectProviderEnv()` 是一个过渡桥接——当前 AI SDK 的 provider 实现依赖 `process.env` 中的标准环境变量名来自动发现 API key。长期目标是 runtime/llm 层仅消费显式 provider 配置。

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
  readonly chat: (prompt: string, options?: ChatOptions) => AsyncIterable<RuntimeEvent>
}

interface ChatOptions {
  readonly systemPrompt?: string   // 覆盖 SOUL.md
}
```

`chat()` 方法：
1. 在 runtime 上创建 session
2. 构造 user message
3. 调用 `runTurn()`
4. 返回 `streamEvents()` 的 AsyncIterable

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
  "pid": 1234
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
data: {"type":"chat.error","code":"BUSY","message":"Another chat is in progress"}

```

**并发控制**：同一时刻只允许一个 chat 请求。并发请求收到 `code: 'BUSY'` 错误。

#### POST /shutdown

触发优雅关闭：

```json
{
  "ok": true
}
```

关闭流程：等待活跃 chat 完成（20ms 轮询） → 关闭 HTTP server → 删除端口/PID 文件。

### 6.3 SSE 编解码

#### 消息类型

```typescript
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

### 6.4 状态文件

| 文件 | 内容 | 生命周期 |
|------|------|---------|
| `~/.config/tianji-ai/daemon.port` | 监听端口号（字符串） | server.listen → shutdown |
| `~/.config/tianji-ai/daemon.pid` | 进程 PID（字符串） | server.listen → shutdown |

CLI 通过读取端口文件来发现运行中的 daemon，通过 PID 文件判断进程是否存活。

### 6.5 关闭保证

`DaemonServer.shutdown()` 是幂等的——多次调用返回同一个 Promise。关闭步骤：

1. 等待活跃 chat 完成
2. 关闭 HTTP server
3. 删除 `daemon.port` 和 `daemon.pid`

---

## 7. 依赖约束

| 允许的外部依赖 | 允许的内部依赖 | 禁止依赖 |
|--------------|--------------|---------|
| `zod`（可选） | `@tianji/shared`, `@tianji/runtime` | `ai`, `@ai-sdk/*`, `@langchain/*`, Provider SDK, `apps/*` |

agent 包不直接使用任何 LLM 框架——它通过 runtime 的公共 API 间接使用。这确保 AI SDK / LangChain 的类型不会泄漏到上层。

---

## 8. 模块组织

```text
packages/agent/src/
├─ index.ts              # 公共导出
├─ context.ts            # 上下文装配、路径解析、首次初始化、凭据注入
├─ session.ts            # createAgentRuntime、createAgentSession
├─ daemon-protocol.ts    # SSE 常量、消息类型、编码函数
├─ daemon-server.ts      # DaemonServer（HTTP + SSE）
└─ daemon-client.ts      # DaemonClient（HTTP + SSE 解析）
```
