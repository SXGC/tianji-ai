# @tianji/cli

`@tianji/cli` 是 `tianji-ai` 的命令行入口，提供 `run` 和 `log` 两个命令。

## 安装与运行

在 monorepo 内可先构建 CLI：

```bash
pnpm --filter @tianji/cli build
```

构建后可通过以下方式运行：

```bash
pnpm tianji run "hello"
pnpm tianji log -f
```

`apps/cli/package.json` 中声明了 `bin.tianji -> ./bin/tianji.mjs`。在 monorepo 开发环境里，推荐通过仓库根脚本 `pnpm tianji` 调用；如果将包链接到全局环境，也可以直接执行 `tianji`。

## 命令用法

### `tianji run "<prompt>"`

- 发送一条 prompt 给默认 agent。
- CLI 会通过 `@tianji/agent` 加载配置、解析默认 agent、读取对应 `SOUL.md`、创建会话，并把 assistant 文本流式输出到 stdout。
- 首次运行时，如果 `~/.config/tianji-ai/` 下缺少配置目录，会自动创建基础目录、空的用户层 `tianji.json`、默认 agent 的 `SOUL.md`，以及日志目录。
- 用法错误返回退出码 `2`，运行时错误返回退出码 `1`。

### `tianji log -f`

- 读取并持续 follow CLI JSONL 日志文件。
- 如果日志文件尚未创建，会先输出等待提示；文件出现后先打印已有内容，再持续输出新增日志。
- CLI 会把 JSONL 渲染为可读文本，而不是直接输出原始 JSON。

示例输出：

```text
2026-03-25T10:00:00.000Z INFO  cli > run > config       Loaded user config context {"agentName":"default","provider":"openai","modelName":"gpt-4.1"}
2026-03-25T10:00:01.200Z INFO  cli > run > runtime      Session runtime created {"agentName":"default","provider":"openai","modelName":"gpt-4.1"}
2026-03-25T10:00:02.100Z DEBUG cli > run > event        Received runtime event {"eventType":"message.delta"}
```

## 配置文件位置

| 路径 | 说明 |
|---|---|
| `~/.config/tianji-ai/tianji.json` | 主配置文件 |
| `~/.config/tianji-ai/agents/<agent-name>/SOUL.md` | agent 身份定义 |
| `~/.config/tianji-ai/logs/tianji.log` | CLI JSONL 日志文件 |

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
  }
}
```

- `providers.<name>`：provider 连接信息映射，例如 `apiKey`、`baseUrl` 或其他 provider 自定义字段。值支持 `${env:VAR_NAME}` 占位符。
- `agents.defaultAgent`：默认 agent 名称，对应 `agents.items` 中的一个 key。
- `agents.items.<name>.model`：使用 `provider/modelName` 格式引用模型，只按第一个 `/` 切分，因此模型名自身可以包含 `/`。
- `runtime`：运行时配置，例如重试与工具超时等公共参数。
- `observer`：观察者配置，例如 `enabled`、`redactSecrets`。
- 占位符解析：所有字符串值中的 `${env:VAR_NAME}` 会在运行时解析；环境变量不存在时直接报错。

## Agent 目录规则

- agent 名称必须匹配 `^[a-z0-9][a-z0-9-_]*$`。
- 每个 agent 的 `SOUL.md` 固定在 `~/.config/tianji-ai/agents/<agent-name>/SOUL.md`。
- `SOUL.md` 定义 agent 的价值观、边界与协作方式，agent 包会把文件内容作为 `systemPrompt` 传给 runtime。
- `SOUL.md` 必须存在且非空；缺失、不可读或空文件都会直接报错。
- 首次运行时，CLI 会为默认 agent 自动创建一个基础 `SOUL.md`。

## 日志系统

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

日志中会保留 `agentName`、`provider`、`modelName`、`soulPath`、`sessionId`、`runId` 等元信息，但会过滤 `apiKey`、`prompt`、`soul` 等敏感字段，不记录 `SOUL.md` 正文或 prompt 正文。

## 错误处理

| 场景 | 行为 |
|---|---|
| 未传命令 | 输出 usage，退出码 `2` |
| `run` 缺少或多传 prompt 参数 | 输出 `Command "run" requires exactly one prompt argument.`，退出码 `2` |
| `log` 未使用 `-f` 或 `--follow` | 输出 `Command "log" only supports "-f" or "--follow".`，退出码 `2` |
| 未知命令 | 输出 `Unknown command "<name>".`，退出码 `2` |
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
| 其他运行时异常 | 输出错误信息，写入 `cli > main` 错误日志，并以退出码 `1` 退出 |

## 目录结构

```text
apps/cli/
├─ bin/
│  └─ tianji.mjs
├─ src/
│  ├─ bin.ts
│  ├─ config.ts
│  ├─ log-follow.ts
│  ├─ logger.ts
│  └─ main.ts
├─ package.json
├─ README.md
└─ tsconfig.json
```

## 开发命令

```bash
pnpm --filter @tianji/cli build
pnpm --filter @tianji/cli test
pnpm --filter @tianji/cli typecheck
pnpm --filter @tianji/cli clean
```

## 依赖关系

- `@tianji/agent`：配置装配、默认 agent 解析、runtime/session 启动封装。
- `@tianji/runtime`：会话执行、事件流、快照与工具目录。
- `@tianji/shared`：运行时协议类型与配置 schema。

## 许可证

MIT
