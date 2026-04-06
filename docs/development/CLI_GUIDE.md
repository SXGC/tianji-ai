# Tianji AI CLI 用户指南

> 状态：当前
> 日期：2026-04-02
> 相关文档：[`./ARCHITECTURE.md`](./ARCHITECTURE.md)、[`./CONFIG_DESIGN.md`](./CONFIG_DESIGN.md)

---

## 1. 安装与构建

```bash
# 从仓库根目录
pnpm install
pnpm build

# 运行 CLI
pnpm tianji <command>
```

构建完成后，`tianji` 命令通过 `apps/cli/bin/tianji.mjs` 入口启动。

---

## 2. 命令一览

| 命令 | 用途 |
|------|------|
| `tianji run "<prompt>"` | 向默认 agent 发送单次 prompt |
| `tianji log -f [--lines <n>]` | 实时跟踪 CLI 日志并回放最近条目 |
| `tianji daemon start [--fg] [--register <url>]` | 启动后台守护进程 |
| `tianji daemon status` | 查看守护进程状态 |
| `tianji daemon stop` | 停止守护进程 |
| `tianji daemon restart [--fg]` | 重启守护进程 |
| `tianji chat` | 连接守护进程进行多轮对话 |
| `tianji help` | 显示所有命令说明 |

---

## 3. 命令详解

### 3.1 run

```bash
tianji run "<prompt>"
```

向配置的默认 agent 发送一次性 prompt，流式输出 assistant 回复到 stdout。

**行为**：
- 首次运行自动创建配置目录和默认 agent
- 加载三层配置（default < user < workspace）
- 创建 session、执行 run、消费事件流
- 完成后以换行符结束输出

**退出码**：`0` 成功，`1` 运行时错误，`2` 参数错误。

### 3.2 log

```bash
tianji log -f [--lines <n>]
tianji log --follow [-n <n>]
```

实时跟踪 JSONL 日志文件，渲染为人类可读格式。

**参数**：
- `-f` / `--follow`：必需，启动跟踪模式
- `--lines <n>` / `-n <n>`：可选，初始回放行数（默认 100）

**行为**：
- 如果日志文件不存在，500ms 间隔轮询直到文件出现
- 文件出现后先回放最后 N 行历史
- 持续跟踪新写入的日志条目
- 检测文件截断/轮转，自动从头开始

**输出格式**：

```
2026-04-02T10:00:00.000Z INFO  cli > run > config       Loaded user config context {"agentName":"default"}
```

格式为 `TIMESTAMP LEVEL SCOPE MESSAGE {data}`：
- LEVEL：大写，右填充至 5 字符
- SCOPE：用 ` > ` 连接，右填充至 24 字符
- DATA：JSON 格式（如存在）

### 3.3 daemon start

```bash
tianji daemon start          # 后台模式（fork 子进程）
tianji daemon start --fg     # 前台模式（阻塞终端，调试用）
tianji daemon start --register "http://127.0.0.1:3000/register?enrollment-token=<token>"  # 首次注册并启动
```

**后台模式**：
1. 检查是否已有 daemon 在运行（读取端口文件 + ping）
2. 已运行：输出现有进程信息，正常退出
3. 如果传入 `--register`，解析 URL 并准备写入 controlplane 配置
4. 若已有不同 controlplane 配置，交互确认是否覆盖；拒绝覆盖时退出码为 `0`
5. 未运行：清理残留文件，fork 子进程
6. 等待最多 10 秒直到 daemon 就绪
7. 输出：`Daemon started (pid=1234, port=5678)`

**前台模式**：直接在当前终端启动 daemon server，Ctrl+C 停止。

**controlplane 配置规则**：
- 首次启动如果本地没有已保存的 controlplane 配置，必须传入 `--register <url>`
- daemon 启动链路统一从用户配置读取 controlplane 注册信息
- 再次传入相同 `--register` 值时不提示
- 再次传入不同 `--register` 值时提示是否覆盖

### 3.4 daemon status

```bash
tianji daemon status
```

查询守护进程运行状态。

**运行中输出**：

```
Daemon running (pid=1234, port=5678, sessionId=sess_abc123, uptime=3600s)
```

**退出码**：`0` 运行中，`1` 未运行。

### 3.5 daemon stop

```bash
tianji daemon stop
```

向守护进程发送 `/shutdown` 请求，等待优雅关闭。

**输出**：`Daemon stopped`

**退出码**：`0` 已停止，`1` 未运行。

### 3.6 daemon restart

```bash
tianji daemon restart         # 后台重启
tianji daemon restart --fg    # 前台重启
```

先停止现有 daemon（如有），再启动新实例。

`daemon restart` 不接受 `--register`，也不负责变更 controlplane 配置。

### 3.7 chat

```bash
tianji chat
```

连接到运行中的守护进程，启动交互式多轮对话 REPL。

**行为**：
- 通过端口文件发现 daemon，创建 HTTP 客户端
- 显示连接信息：`Connected to daemon (pid=1234)`
- 提示符 `> ` 等待输入
- 每行输入发送到 daemon 的 `/chat` 端点
- 所有轮次共享同一 session 上下文（保持对话历史）
- 退出方式：输入 `.exit` 或按 Ctrl+C

**示例**：

```
Connected to daemon (pid=1234)
> What is 2+2?
The answer is 4.
> Tell me more about that.
...
> .exit
```

**退出码**：`0` 正常退出，`1` daemon 未运行。

### 3.8 help

```bash
tianji help
```

输出所有可用命令及其说明。

---

## 4. 配置文件

### 4.1 文件路径

| 路径 | 用途 | 创建时机 |
|------|------|---------|
| `~/.config/tianji-ai/` | 配置根目录 | 首次 `run` 或 `daemon start` |
| `~/.config/tianji-ai/tianji.json` | 用户层配置 | 首次运行（空 JSON） |
| `~/.config/tianji-ai/agents/` | Agent 定义目录 | 首次运行 |
| `~/.config/tianji-ai/agents/{name}/SOUL.md` | Agent 系统提示词 | 首次运行（默认 agent） |
| `~/.config/tianji-ai/logs/tianji.log` | JSONL 日志文件 | 首次日志写入 |
| `~/.config/tianji-ai/daemon.port` | Daemon 端口号 | `daemon start` |
| `~/.config/tianji-ai/daemon.pid` | Daemon PID | `daemon start` |

controlplane 注册信息也持久化在 `~/.config/tianji-ai/tianji.json` 的 `controlPlane` 字段中，由 `daemon start --register` 写入，后续 `daemon start` / `daemon restart` 复用。

### 4.2 配置加载优先级

```
内置默认配置 < 用户配置 < 工作区配置
```

详见 [`CONFIG_DESIGN.md`](./CONFIG_DESIGN.md)。

### 4.3 用户配置示例

```json
{
  "providers": {
    "openai": {
      "apiKey": "${env:OPENAI_API_KEY}",
      "baseUrl": "https://api.openai.com/v1"
    },
    "anthropic": {
      "apiKey": "${env:ANTHROPIC_API_KEY}"
    }
  },
  "agents": {
    "defaultAgent": "default",
    "items": {
      "default": {
        "model": "openai/gpt-4.1"
      }
    }
  }
}
```

`${env:VAR_NAME}` 占位符在加载时替换为对应环境变量值。

---

## 5. 环境变量

无"无条件必需"的环境变量。以下变量仅在使用对应 provider 且未在 JSON 配置中直接指定 `apiKey` 时需要：

| 变量 | 对应 Provider |
|------|-------------|
| `OPENAI_API_KEY` | openai |
| `ANTHROPIC_API_KEY` | anthropic |
| `GOOGLE_GENERATIVE_AI_API_KEY` | google |

---

## 6. Daemon 生命周期

### 6.1 启动流程

```
daemon start [--register <url>]
  → 检查端口文件是否存在 + ping 验证
  → 已运行？输出信息，退出
  → 如传入 --register：解析 URL，加载已有 controlplane 配置
  → 配置冲突？提示是否覆盖；拒绝则退出
  → 清理残留文件
  → fork 子进程（detached, stdio='ignore'）
  → 子进程：从用户配置读取 controlplane 配置 → loadAgentContext → createAgentSession → DaemonServer.listen(0)
  → 父进程：轮询端口文件 + ping，最多等 10 秒
  → 输出 pid 和 port
```

### 6.2 运行期

- Daemon 在 `127.0.0.1` 上自动选择端口
- 单个 `AgentSession` 持有会话上下文
- 同时只处理一个 `/chat` 请求（BUSY 拒绝并发）
- 通过 `/ping` 提供健康检查

### 6.3 关闭流程

```
daemon stop
  → 读取端口文件
  → POST /shutdown
  → Server 等待活跃 chat 完成
  → 关闭 HTTP server
  → 删除 daemon.port 和 daemon.pid
```

SIGTERM / SIGINT 信号也触发相同的优雅关闭流程。

---

## 7. 日志系统

### 7.1 写入

- `@tianji/observer` 提供结构化日志 API
- CLI 使用 JSONL file sink 写入 `~/.config/tianji-ai/logs/tianji.log`
- 每条日志一行 JSON，包含 `timestamp`、`level`、`scope`、`message`、`data`

### 7.2 脱敏

日志自动过滤以下敏感字段（完全移除，不出现在日志中）：

- `apiKey`：Provider API 密钥
- `prompt`：用户原始输入
- `soul`：SOUL.md 系统提示词内容

### 7.3 查看

通过 `tianji log -f` 命令查看。支持 `--lines` 参数控制初始回放行数。

---

## 8. 退出码

| 退出码 | 含义 |
|-------|------|
| `0` | 成功 |
| `1` | 运行时错误或操作失败 |
| `2` | 命令参数错误 |
