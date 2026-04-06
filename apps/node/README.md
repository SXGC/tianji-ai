# @tianji/node

`@tianji/node` 是 `tianji-ai` 的节点命令行入口，当前提供 `run`、`log`、`daemon`、`chat` 和 `help` 能力，并支持全局 `-h` / `--help` 与 `-V` / `--version`。

## 安装与运行

在 monorepo 内可先构建 node app：

```bash
pnpm build
```

构建后可通过以下方式运行：

```bash
pnpm tianji --help
pnpm tianji run "hello"
pnpm tianji daemon start --register "http://127.0.0.1:3000/register?enrollment-token=<enrollment-token>"
pnpm tianji log --lines 20
pnpm tianji help daemon
```

`apps/node/package.json` 中声明了 `bin.tianji -> ./bin/tianji.mjs`。在 monorepo 开发环境里，推荐通过仓库根脚本 `pnpm tianji` 调用；如果将包链接到全局环境，也可以直接执行 `tianji`。

## 命令用法

### `tianji run "<prompt>"`

- 发送一条 prompt 给默认 agent。
- 当前 node app 仍会通过 `@tianji/agent` 加载配置、解析默认 agent、读取对应 `SOUL.md`、创建会话，并把 assistant 文本流式输出到 stdout；后续将迁移为 ACP 管理模式。
- 首次运行时，如果 `~/.config/tianji-ai/` 下缺少配置目录，会自动创建基础目录、空的用户层 `tianji.json`、默认 agent 的 `SOUL.md`，以及日志目录。
- 用法错误返回退出码 `2`，运行时错误返回退出码 `1`。

### `tianji log [--follow] [--lines <n>]`

- 读取并持续 follow observer 写出的 JSONL 日志文件。
- 如果日志文件尚未创建，会先输出等待提示；文件出现后默认先回放最近 `100` 行，再持续输出新增日志。
- 当前保持 follow 为默认行为；`--follow` / `-f` 作为语义规范化和后续扩展预留。
- 可通过 `--lines <n>` 或 `-n <n>` 调整首次回放的行数，例如 `tianji log --lines 20`。
- `@tianji/observer` 负责生成 JSONL 记录；node app 负责 follow 文件并把 JSONL 渲染为可读文本，而不是直接输出原始 JSON。

## Daemon 命令

### `tianji daemon start [--fg]`

启动后台守护进程。守护进程内部持有一个 `AgentSession`，通过 `localhost` HTTP 对外提供服务。

- 默认行为：fork 一个后台子进程，将端口号写入 `~/.config/tianji-ai/daemon.port`，PID 写入 `~/.config/tianji-ai/daemon.pid`。
- `--fg`：以前台模式运行，方便调试。前台模式下进程不会 fork，直接在当前终端中运行。
- `--register <url>`：首次启动时写入 controlplane 注册配置，并立即用该配置启动 daemon。URL 格式固定为 `http://cp_base_url/register?enrollment-token=xxxxx`。
- 如果检测到已有守护进程在运行（端口文件存在且可以 ping 通），会直接输出已有进程信息，不会重复启动。
- 如果本地还没有保存过 controlplane 注册配置，首次启动必须显式传入 `--register`。
- 如果再次传入不同的 `--register` URL，CLI 会先交互确认是否覆盖已有配置；拒绝覆盖时直接退出，不启动 daemon。
- `tianji run "<prompt>"` 不会注册 node；它只会执行一次本地 CLI 请求。
- 已移除顶层 `tianji register` 命令，以及更早期依赖环境变量自动进入 controlplane 模式的行为。

### `tianji daemon status`

检查守护进程是否正在运行。输出 pid、port、sessionId 和 uptime 信息。

- 如果守护进程未运行，输出错误信息并以退出码 `1` 退出。

### `tianji daemon stop`

调用守护进程的 `/shutdown` 端点，等待其优雅退出。

- 如果守护进程未运行，输出错误信息并以退出码 `1` 退出。

### `tianji daemon restart [--fg]`

重启守护进程（先停止再启动）。

- `--fg`：重启后以前台模式运行。
- 如果当前有守护进程在运行，会先停止它，再启动新实例。
- `restart` 只复用已保存的 controlplane 配置，不负责更新注册配置。

### `tianji chat`

连接到正在运行的后台守护进程，进入 readline REPL 进行多轮对话。所有轮次共享同一个 session 上下文。

- 输入 `.exit` 或按 `Ctrl+C` 退出。
- 如果守护进程未运行，会提示 `No daemon running. Start with: tianji daemon` 并以退出码 `1` 退出。
- 交互过程中，assistant 的文本响应会流式输出到 stdout。

### `tianji help`

- `tianji help` 等价于 `tianji --help`。
- `tianji <command> --help` 或 `tianji help <command>` 会打印命令级帮助。
- 用法错误只输出精简错误，不再附带完整帮助文本。

示例输出：

```text
2026-03-25T10:00:00.000Z INFO  cli > run > config       Loaded user config context {"agentName":"default","provider":"openai","modelName":"gpt-4.1"}
2026-03-25T10:00:01.200Z INFO  cli > run > runtime      Session runtime created {"agentName":"default","provider":"openai","modelName":"gpt-4.1"}
2026-03-25T10:00:02.100Z DEBUG cli > run > event        Received runtime event {"eventType":"message.delta","channel":"text","delta":"hello","deltaLength":5}
```

## 配置文件位置

| 路径 | 说明 |
|---|---|
| `~/.config/tianji-ai/tianji.json` | 主配置文件 |
| `~/.config/tianji-ai/agents/<agent-name>/SOUL.md` | agent 身份定义 |
| `~/.config/tianji-ai/logs/tianji.log` | observer JSONL 日志文件，供 CLI follow |
| `~/.config/tianji-ai/daemon.port` | 守护进程监听端口号 |
| `~/.config/tianji-ai/daemon.pid` | 守护进程 PID |

controlplane 注册信息也会持久化到 `~/.config/tianji-ai/tianji.json` 的 `controlPlane` 字段中，供后续 `daemon start` 和 `daemon restart` 复用。

## 配置文件结构

`tianji.json` 的核心字段示例：

```json
{
  "providers": {
    "openai": {
      "apiKey": "${env:OPENAI_API_KEY}"
    }
  },
  "agents": {
    "defaultAgent": "default",
    "items": {
      "default": {
        "model": "openai/gpt-4.1"
      }
    }
  },
  "runtime": {
    "retry": {
      "maxAttempts": 2
    }
  },
  "observer": {
    "enabled": true
  },
  "locale": "zh-CN"
  }
}
```

- `providers.<name>`：provider 连接信息映射，例如 `apiKey`、`baseUrl` 或其他 provider 自定义字段。值支持 `${env:VAR_NAME}` 占位符。
- `agents.defaultAgent`：默认 agent 名称，对应 `agents.items` 中的一个 key。
- `agents.items.<name>.model`：使用 `provider/modelName` 格式引用模型，只按第一个 `/` 切分，因此模型名自身可以包含 `/`。
- `runtime`：运行时配置，例如重试与工具超时等公共参数。
- `observer`：观察者配置，例如 `enabled`、`redactSecrets`。
- `locale`：CLI 用户可见文案语言，目前支持 `en` 与 `zh-CN`。
- 占位符解析：所有字符串值中的 `${env:VAR_NAME}` 会在运行时解析；环境变量不存在时直接报错。

## Agent 目录规则

- agent 名称必须匹配 `^[a-z0-9][a-z0-9-_]*$`。
- 每个 agent 的 `SOUL.md` 固定在 `~/.config/tianji-ai/agents/<agent-name>/SOUL.md`。
- `SOUL.md` 定义 agent 的价值观、边界与协作方式，agent 包会把文件内容作为 `systemPrompt` 传给 runtime。
- `SOUL.md` 必须存在且非空；缺失、不可读或空文件都会直接报错。
- 首次运行时，node app 会为默认 agent 自动创建一个基础 `SOUL.md`。

## 日志系统

`@tianji/observer` 统一负责结构化日志协议与 JSONL 生成，当前 node app 只负责两件事：

- 在 `run` 等命令流程中调用 observer logger 写日志。
- 在 `log [--follow]` 中先回放尾部指定行数，再继续读取同一个 JSONL 文件并渲染输出。

日志文件使用 JSONL，每行一条 JSON 记录。原始字段结构如下：

```json
{
  "timestamp": "2026-03-25T10:00:00.000Z",
  "level": "info",
  "scope": ["cli", "run", "config"],
  "message": "Loaded user config context",
  "data": { "agentName": "default" }
}
```

常见 `scope`：

| scope | 说明 |
|---|---|
| `cli > run` | run 命令主流程 |
| `cli > run > config` | 配置加载与解析 |
| `cli > run > runtime` | runtime 创建与启动 |
| `cli > run > event` | runtime 事件消费 |
| `cli > log > follow` | log follow 主流程 |
| `cli > main` | CLI 顶层错误记录 |
| `daemon > controlplane` | daemon 与 controlplane 的注册、心跳、收取任务 |
| `daemon > task` | daemon 开始处理 task 与任务执行细节 |

日志中会保留 `agentName`、`provider`、`modelName`、`soulPath`、`sessionId`、`runId` 等元信息；对于 `message.delta` 事件，还会记录 `channel`、`delta` 和 `deltaLength` 以便排查流式输出问题。但会过滤 `apiKey`、`prompt`、`soul` 等敏感字段，不记录 `SOUL.md` 正文或 prompt 正文。JSONL 的写入格式与脱敏行为都由 `@tianji/observer` 提供。

daemon 相关新增日志约定：

- 心跳发送使用 `debug`，记录发送开始、发送成功与失败原因。
- 接收到 controlplane 下发 task 时，接收摘要写 `info`，完整 task 明细写 `debug`。
- daemon 开始处理 task 写 `info`，处理过程中的 runner 创建、事件流打开、runtime 事件转发、收尾清理写 `debug`。
- daemon 收到 `SIGTERM` / `SIGINT` 时写退出 `info`；捕获未处理异常或未处理 Promise 拒绝时先写 `error`，再写退出 `info`。

## 错误处理

| 场景 | 行为 |
|---|---|
| 未传命令 | 输出 `Missing command.`，退出码 `2` |
| `run` 缺少 prompt 参数 | 输出 `Missing required argument <prompt>.`，退出码 `2` |
| `log` 的 `--lines`/`-n` 非正整数 | 输出 `Option "--lines" requires a valid number.`，退出码 `2` |
| 未知选项 | 输出 `Unknown option "<name>".`，退出码 `2` |
| 未知命令 | 输出 `Unknown command "<name>".` + help hint，退出码 `2` |
| 配置目录或配置文件不存在 | 自动创建目录、空的用户层 `tianji.json` 与默认 `SOUL.md` |
| 配置文件 JSON 解析失败 | 直接报错退出 |
| 配置 schema 不合法 | 直接报错退出 |
| 缺失 `agents.defaultAgent` | 报错：`Missing agents.defaultAgent in Tianji config` |
| 缺失 `agents.items` | 报错：`Missing agents.items in Tianji config` |
| `agents.items` 中无默认 agent 对应项 | 报错：`Default agent "<name>" is not defined in agents.items` |
| `model` 格式非法 | 报错：`Invalid agent model reference "<value>": ...` |
| agent 名称不合法 | 报错：`Agent name "<name>" must match /^[a-z0-9][a-z0-9-_]*$/` |
| `SOUL.md` 缺失 | 报错：`Agent soul file does not exist: <path>` |
| `SOUL.md` 不可读 | 报错：`Agent soul file is not readable: <path>` |
| `SOUL.md` 为空 | 报错：`Agent soul file is empty: <path>` |
| 环境变量未设置 | 占位符解析阶段报错：`Environment variable "<name>" is not defined` |
| runtime 发出 `run.failed` 事件 | CLI 抛出 `Run failed: <message>`，写入日志并以退出码 `1` 退出 |
| 其他运行时异常 | 输出错误信息并以退出码 `1` 退出 |

## 目录结构

```text
apps/node/
├─ bin/
│  └─ tianji.mjs
├─ src/
│  ├─ bin.ts
│  ├─ commands/
│  ├─ config.ts
│  ├─ daemon-entry.ts
│  ├─ i18n/
│  ├─ log-follow.ts
│  ├─ logger.ts
│  └─ main.ts
├─ package.json
├─ README.md
└─ tsconfig.json
```

## 开发命令

```bash
pnpm build
pnpm --filter @tianji/node test
pnpm --filter @tianji/node typecheck
pnpm --filter @tianji/node clean
```

## 依赖关系

- `@tianji/agent`：配置装配、默认 agent 解析、runtime/session 启动封装，以及 `DaemonServer` / `DaemonClient` 的 daemon 协议实现。
- `@tianji/observer`：结构化 logger、JSONL sink 与 tracing 初始化原语。
- `@tianji/runtime`：会话执行、事件流、快照与工具目录。
- `@tianji/shared`：运行时协议类型与配置 schema。

## 许可证

MIT
