# Tianji Daemon + Chat REPL 设计

> **For agentic workers:** 本文档定义 `tianji daemon` 与 `tianji chat` 的交互模型、IPC 协议与实现规划。后续实现以本文为准。

## 现状

当前 `tianji run "<prompt>"` 是单次调用模式：每次执行都要重新加载配置、创建 session、完成一轮对话后退出。没有任何进程间通信、守护进程或长驻 session 机制。

这意味着：

- 每次调用都有冷启动开销（配置加载、LLM 握手）。
- 多轮对话无法保持上下文——上一轮的对话历史在进程退出时丢失。
- 无法在后台持有一个就绪的 agent session 等待输入。

## 目标

引入两个新命令：

| 命令 | 职责 |
|------|------|
| `tianji daemon` | 启动后台守护进程，持有 `AgentSession`，监听 HTTP 请求 |
| `tianji chat` | 连接 daemon，进入交互式 REPL，多轮对话共享同一 session |

附带两个辅助命令：`tianji status`（检查 daemon 状态）、`tianji stop`（优雅关闭 daemon）。

## 不做什么

- **不做多 session 管理。** daemon 持有一个 session。需要多 session 时再扩展。
- **不做认证/授权。** daemon 绑定 `localhost`，单用户本地工具，不需要 token 或 auth header。
- **不做 Web UI。** HTTP 接口为 CLI 设计，未来接 Web UI 时可以在此基础上扩展，但不是本次范围。
- **不引入外部 TUI 库。** REPL 使用 `node:readline` 内置模块。
- **不引入外部 HTTP 框架。** 使用 `node:http` 内置模块。

## 架构决策

### IPC 方案：HTTP + SSE

**选择 HTTP server on localhost + Server-Sent Events (SSE) 流式响应。**

为什么不是 Unix Domain Socket + NDJSON？

- HTTP 调试友好：`curl` 即可测试所有端点。
- SSE 是标准协议，浏览器原生支持，未来扩展到 Web UI 时零改动。
- 与 OpenAI API 的流式模式一致，开发者熟悉。

为什么不是 WebSocket？

- 当前场景是「发送 prompt → 流式接收回复」的请求-响应模式，不需要服务端主动推送。
- WebSocket 需要引入 `ws` 库（`node:http` 不原生支持 WebSocket 帧协议），违背零外部依赖原则。
- 未来如果需要服务端主动推送（如工具审批请求），可以在 SSE 基础上扩展或引入 WebSocket。

### 端口管理

daemon 启动时绑定 `localhost:0`（操作系统分配随机可用端口），将端口号写入 `~/.config/tianji-ai/daemon.port`。客户端读取该文件获取端口。

为什么不是固定端口？

- 固定端口可能被其他程序占用。
- 随机端口 + 文件记录是 daemon 工具的标准做法（如 Gradle daemon）。

### 进程管理

- PID 文件：`~/.config/tianji-ai/daemon.pid`
- 分离方式：`child_process.fork()` + `detached: true` + `unref()`
- 日志：daemon 日志写入 observer JSONL（`~/.config/tianji-ai/logs/tianji.log`）

## HTTP API 设计

### `POST /chat`

发送一轮对话，流式返回 agent 响应。

**请求：**

```http
POST /chat HTTP/1.1
Content-Type: application/json

{ "prompt": "帮我写一个快速排序" }
```

**响应：** SSE 流（`Content-Type: text/event-stream`）

```
event: chat.event
data: {"type":"message.delta","runId":"run_1","channel":"text","payload":{"content":"好的"}}

event: chat.event
data: {"type":"message.delta","runId":"run_1","channel":"text","payload":{"content":"，这是"}}

event: chat.event
data: {"type":"run.completed","runId":"run_1","sessionId":"session_1"}

event: chat.done
data: {}

```

**并发限制：** 同一时刻只允许一个 `/chat` 请求。如果有正在进行的 chat，立即返回错误：

```
event: chat.error
data: {"code":"BUSY","message":"Another chat is in progress"}

```

### `GET /ping`

健康检查。

**响应：**

```json
{
  "sessionId": "session_1711843200000",
  "uptime": 3600,
  "pid": 12345
}
```

### `POST /shutdown`

优雅关闭 daemon。

**响应：**

```json
{ "ok": true }
```

响应发送后，daemon 停止接受新连接，等待活跃 chat 完成（最多 30 秒超时），然后清理 `daemon.port` 和 `daemon.pid` 文件，退出进程。

## SSE 事件协议

所有 SSE 事件遵循标准格式：`event:` 行 + `data:` 行 + 空行。

| 事件名 | 数据结构 | 含义 |
|--------|----------|------|
| `chat.event` | `{ type: RuntimeEvent['type'], ...RuntimeEvent }` | 一个 runtime 事件，payload 是完整的 `RuntimeEvent` 对象 |
| `chat.done` | `{}` | 本轮对话完成 |
| `chat.error` | `{ code: string, message: string }` | 错误，`code` 可选值：`BUSY`、`INTERNAL` |

`chat.event` 中的 `RuntimeEvent` 复用 `@tianji/shared` 中已有的类型定义，不引入新的事件类型。

## 类型定义

```typescript
// ─── HTTP 请求体 ───
interface ChatRequestBody {
  readonly prompt: string
}

// ─── HTTP 响应体 ───
interface PingResponse {
  readonly sessionId: string
  readonly uptime: number
  readonly pid: number
}

interface ShutdownResponse {
  readonly ok: true
}

// ─── SSE 事件 ───
interface ChatEventSSE {
  readonly type: 'chat.event'
  readonly event: RuntimeEvent
}

interface ChatDoneSSE {
  readonly type: 'chat.done'
}

interface ChatErrorSSE {
  readonly type: 'chat.error'
  readonly code: 'BUSY' | 'INTERNAL'
  readonly message: string
}

type ChatSSEMessage = ChatEventSSE | ChatDoneSSE | ChatErrorSSE
```

## Daemon Server 行为

### 启动流程

```text
tianji daemon
  │
  ├─ 检查 daemon.port + daemon.pid 是否存在
  │  ├─ 存在 → GET /ping
  │  │  ├─ 成功 → 打印 "Daemon already running (pid=XXXX)" → 退出
  │  │  └─ 失败 → 清理 stale 文件 → 继续启动
  │  └─ 不存在 → 继续启动
  │
  ├─ fork daemon-entry.ts (detached, stdio: ignore)
  │  │
  │  │  [子进程]
  │  │  ├─ loadAgentContext()
  │  │  ├─ createAgentSession(context)
  │  │  ├─ http.createServer() → listen(0, '127.0.0.1')
  │  │  ├─ 写入 daemon.port (端口号)
  │  │  ├─ 写入 daemon.pid (process.pid)
  │  │  ├─ 注册 SIGTERM/SIGINT → graceful shutdown
  │  │  └─ 保持进程存活
  │  │
  │  └─ [父进程] 等待 port 文件出现 → 打印 "Daemon started (pid=XXXX, port=YYYY)" → 退出
  │
  └─ --fg 模式：跳过 fork，直接在当前进程运行 server（调试用）
```

### 并发模型

- **单 session**：daemon 生命周期内持有一个 `AgentSession`。
- **单 chat**：同一时刻只允许一个 `/chat` 请求活跃（`SessionRuntime` 不支持并发 `runTurn`）。用布尔锁控制。
- **多连接**：`/ping`、`/shutdown` 不受 chat 锁限制，可以并发访问。

### 优雅关闭

```text
POST /shutdown
  │
  ├─ 停止 accept 新连接
  ├─ 等待活跃 chat 完成 (最多 30s)
  ├─ 关闭 HTTP server
  ├─ 删除 daemon.port
  ├─ 删除 daemon.pid
  └─ process.exit(0)
```

SIGTERM/SIGINT 触发同样的关闭流程。

## Chat REPL 行为

```text
tianji chat
  │
  ├─ 读取 daemon.port → 连接 daemon
  │  └─ 失败 → 打印 "No daemon running. Start with: tianji daemon" → 退出
  │
  ├─ GET /ping → 打印 "Connected to daemon (pid=XXXX)"
  │
  └─ REPL 循环 (node:readline)
     │
     ├─ 提示符: "> "
     ├─ 读取用户输入
     │  ├─ 空行 → 跳过
     │  ├─ ".exit" → 断开连接，退出
     │  └─ Ctrl+C → 断开连接，退出
     │
     ├─ POST /chat { prompt }
     │  ├─ 解析 SSE 流
     │  │  ├─ chat.event (message.delta, channel=text) → process.stdout.write(content)
     │  │  ├─ chat.event (其他类型) → 忽略或 debug 日志
     │  │  ├─ chat.done → 换行，恢复提示符
     │  │  └─ chat.error → 打印错误信息，恢复提示符
     │  └─ 网络错误 → 打印 "Connection lost"，退出
     │
     └─ 继续循环
```

## 代码组织

### 新增文件

| 文件 | 层 | 职责 |
|------|----|------|
| `packages/agent/src/daemon-protocol.ts` | L2 | 请求/响应/SSE 事件类型定义 |
| `packages/agent/src/daemon-server.ts` | L2 | `DaemonServer` 类：HTTP server、session 持有、路由 |
| `packages/agent/src/daemon-client.ts` | L2 | `DaemonClient` 类：HTTP 请求、SSE 解析、`AsyncIterable<RuntimeEvent>` |
| `apps/cli/src/daemon-entry.ts` | L3 | daemon 子进程入口 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `packages/agent/src/context.ts` | `AgentAppPaths` 增加 `daemonPortPath`、`daemonPidPath` |
| `packages/agent/src/index.ts` | 导出 daemon 相关模块 |
| `apps/cli/src/main.ts` | 增加 `daemon`、`chat`、`status`、`stop` 命令分支 |

### 不需要修改的文件

- `@tianji/shared` — 不引入新类型，复用 `RuntimeEvent`。
- `@tianji/runtime` — daemon 通过 `@tianji/agent` 间接使用，不直接耦合。
- `@tianji/observer` — daemon 日志通过现有 logger 输出，不新增 sink。

## 关键设计约束

### `DaemonClient.sendChat()` 签名对齐

```typescript
// AgentSession（已有）
interface AgentSession {
  chat(prompt: string, options?: ChatOptions): AsyncIterable<RuntimeEvent>
}

// DaemonClient（新增）
class DaemonClient {
  sendChat(prompt: string): AsyncIterable<RuntimeEvent>
}
```

两者返回相同的 `AsyncIterable<RuntimeEvent>`。CLI 的 `handleRuntimeEvent()` 函数无需修改，既可以消费本地 session 的事件，也可以消费 daemon 客户端的事件。

### SSE 解析

客户端用简单的行缓冲器解析 SSE：

```text
累积 HTTP 响应的 data chunk → 按 \n 分行
  ├─ "event: xxx"  → 记住事件名
  ├─ "data: {...}" → JSON.parse → 配合事件名生成 ChatSSEMessage
  ├─ 空行          → 分隔符，发送已缓冲的事件
  └─ 其他行        → 忽略（SSE spec 允许注释等）
```

不需要外部 SSE 解析库，约 30 行代码。

### Socket 文件与竞态

多个 `tianji daemon` 同时启动时可能竞争 port/pid 文件写入。处理方式：

1. 先检查 + ping（乐观检测）。
2. 如果两个进程同时通过检测，后启动的写入 port 文件会覆盖先启动的——但先启动的 server 仍在运行。
3. 客户端连接时以 port 文件中的端口为准，如果该端口无响应则报错。

这对于单用户 CLI 工具来说足够了。不需要文件锁。

## 依赖

**零新增外部依赖。** 全部使用 Node.js 内置模块：

- `node:http` — HTTP server 与 client
- `node:fs/promises` — 文件读写
- `node:child_process` — daemon 进程分离
- `node:readline` — REPL 交互
