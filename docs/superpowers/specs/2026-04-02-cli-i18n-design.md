# CLI 命令架构重构与 i18n 国际化设计

> **For agentic workers:** 本文档定义 `@tianji/cli` 的命令架构重构方案与国际化（i18n）设计。两者紧密耦合——声明式命令注册为 i18n 提供结构化基础，i18n 为命令架构提供统一的文本输出层。后续实现以本文为准。

## 一、现状分析

### 1.1 命令结构现状

当前 CLI 命令通过手写 if/else 链解析，命令定义、帮助文本、解析逻辑三者分离在 `main.ts` 的不同位置：

```typescript
// 帮助文本：手写字符串常量（L20-44）
const CLI_HELP_TEXT = ['Usage:', '  tianji run "<prompt>"', ...].join('\n')

// 解析逻辑：if/else 链（L108-154）
if (commandName === 'run') { ... }
if (commandName === 'help') { ... }
if (commandName === 'daemon') { ... }

// 分发逻辑：又一轮 if/else（L245-288）
if (command.kind === 'run') return await handleRunCommand(command, deps)
if (command.kind === 'help') return handleHelpCommand(deps)
```

**问题：**

| 问题 | 影响 |
|------|------|
| 缺少 `-h`/`--help` 全局 flag | 用户输入 `tianji -h` 得到 "Unknown command" 错误 |
| 缺少 `--version`/`-V` | 无法查看版本号 |
| help text 与解析逻辑不同步 | 新增命令需改 3 处（help 常量、parseCliArgs、runCli 分发），容易遗漏 |
| `log -f` 语义含糊 | `-f` 被当作 positional argument 而非 flag |
| 无命令级帮助 | `tianji run --help` 不工作 |
| 错误消息嵌入完整 help text | 用法错误时输出一大段文本，噪音过大 |
| `main.ts` 714 行职责过重 | 类型定义、解析、分发、handler、工具函数全在一个文件 |

### 1.2 i18n 现状

所有用户可见字符串硬编码在 TypeScript 源码中，分散在 `main.ts`（~40 处）和 `log-follow.ts`（~5 处）：

```typescript
throw new CliUsageError(`Missing command.\n\n${CLI_HELP_TEXT}`)
process.stdout.write(`Daemon already running (pid=${ping.pid})\n`)
process.stdout.write(`Waiting for CLI log file: ${logFilePath}\n`)
```

**问题：**

- CLI 只能输出英文。
- 新增/修改文案需要改源码、重新编译。
- 无法复用翻译文件给其他前端（如未来的 Web UI）。

## 二、目标

### 命令架构目标

- 支持 `-h`/`--help` 全局 flag，可出现在任何命令后。
- 支持 `--version`/`-V` 全局 flag。
- 声明式命令注册：每个命令自描述 name、description、args、options、handler。
- 帮助文本从命令定义自动生成，不再手写。
- 错误消息精简，不嵌入完整 help text。
- `main.ts` 拆分为命令模块。

### i18n 目标

- 所有用户可见字符串从源码中抽离，通过 message key 引用。
- 翻译内容存储在 JSON 文件中，支持多语言扩展。
- 运行时根据用户配置或系统 locale 自动选择语言。
- 默认语言 `en`，首批支持 `en` + `zh-CN`。
- 类型安全：编译期检查 key 是否存在。

## 三、不做什么

- **不引入 commander/yargs 等 CLI 框架。** 当前命令数量有限（5 个顶层命令），自建声明式注册足够。
- **不引入 i18next 等 i18n 框架。** CLI 场景字符串数量有限（<100 条），自建轻量方案即可。
- **不支持环境变量配置 locale。** 只读取 `tianji.json` 显式配置和操作系统 locale。
- **不做 plural/gender 等复杂语法。** CLI 消息不涉及复数形式，保持简单。
- **不翻译日志内容。** `CliLogger` 记录的结构化日志保持英文，只翻译面向用户的 stdout/stderr 输出。
- **不翻译内部错误。** 非 `CliUsageError` 的运行时异常保持英文，面向开发者。

## 四、CLI 命令架构设计

### 4.1 CLI 术语定义

以 `git commit -m "fix" --amend file.txt` 为例：

```
git commit -m "fix bug" --amend file.txt
│   │       │  │         │       │
│   │       │  │         │       └─ Argument（位置参数，无 -- 前缀）
│   │       │  │         └─ Flag（布尔开关，无值）
│   │       │  └─ Option value（选项值）
│   │       └─ Option（带值的命名参数，-m 后面跟 value）
│   └─ Command（子命令，动词）
└─ Program（程序名）
```

| 概念 | 说明 | 例子 |
|------|------|------|
| **Command** | 顶层动词或名词，表示要做什么 | `run`, `daemon`, `chat` |
| **Subcommand** | 命令下的二级命令 | `daemon start`, `daemon stop` |
| **Argument** | 位置参数，不带 `--` 前缀，按顺序解析 | `run <prompt>` 中的 prompt |
| **Option** | `--key <value>` 或 `-k <value>`，命名参数，带值 | `--lines 50`, `-n 50` |
| **Flag** | `--name` 或 `-n`，布尔开关，不带值 | `--fg`, `--help`, `-h` |

### 4.2 全局 Flags

全局 flag 在**任何位置**生效，在命令解析之前拦截：

```bash
# 以下全部等价
tianji --help
tianji -h
tianji help

# 命令级帮助
tianji run --help
tianji run -h
tianji daemon --help

# 版本
tianji --version
tianji -V
```

**设计决策：`help` command vs `--help` flag**

| 维度 | `help` command | `-h`/`--help` flag |
|------|---------------|----------------------|
| POSIX 惯例 | 非标准，git/docker/npm 惯例 | **POSIX/GNU 标准** |
| 作用域 | 全局，或 `help <cmd>` 查看具体命令 | 可出现在任何命令后 |
| 用户期望 | 锦上添花 | **必须有**，用户本能输入 |

结论：**两者都支持**。`tianji help` 和 `tianji --help` 输出相同内容。`tianji help daemon` 和 `tianji daemon --help` 输出相同内容。

### 4.3 声明式命令注册

用 `CommandDefinition` 接口描述每个命令的元信息，帮助文本从定义自动生成：

```typescript
// commands/types.ts

export interface ArgumentDefinition {
  readonly name: string            // 如 "prompt"
  readonly description: string     // i18n message key
  readonly required: boolean
}

export interface OptionDefinition {
  readonly long: string            // 如 "--lines"
  readonly short?: string          // 如 "-n"
  readonly description: string     // i18n message key
  readonly type: 'string' | 'number' | 'boolean'
  readonly default?: unknown
}

export interface CommandDefinition {
  readonly name: string            // 如 "run"
  readonly description: string     // i18n message key，如 "cmd.run.description"
  readonly args?: readonly ArgumentDefinition[]
  readonly options?: readonly OptionDefinition[]
  readonly subcommands?: readonly CommandDefinition[]
  readonly handler: CommandHandler
}

export type CommandHandler = (
  context: CommandContext
) => Promise<number>

export interface CommandContext {
  readonly args: Record<string, string>
  readonly options: Record<string, unknown>
  readonly i18n: I18n
  readonly deps: RunCommandDependencies
}
```

**命令注册示例：**

```typescript
// commands/run.ts
export const runCommand: CommandDefinition = {
  name: 'run',
  description: 'cmd.run.description',
  args: [
    { name: 'prompt', description: 'cmd.run.arg.prompt', required: true },
  ],
  handler: handleRunCommand,
}

// commands/daemon.ts
export const daemonCommand: CommandDefinition = {
  name: 'daemon',
  description: 'cmd.daemon.description',
  subcommands: [
    {
      name: 'start',
      description: 'cmd.daemon.start.description',
      options: [
        { long: '--fg', description: 'cmd.daemon.start.option.fg', type: 'boolean' },
      ],
      handler: handleDaemonStartCommand,
    },
    {
      name: 'status',
      description: 'cmd.daemon.status.description',
      handler: handleDaemonStatusCommand,
    },
    {
      name: 'stop',
      description: 'cmd.daemon.stop.description',
      handler: handleDaemonStopCommand,
    },
    {
      name: 'restart',
      description: 'cmd.daemon.restart.description',
      options: [
        { long: '--fg', description: 'cmd.daemon.restart.option.fg', type: 'boolean' },
      ],
      handler: handleDaemonRestartCommand,
    },
  ],
  handler: (_ctx) => { throw new Error('requires subcommand') },
}

// commands/log.ts
export const logCommand: CommandDefinition = {
  name: 'log',
  description: 'cmd.log.description',
  options: [
    { long: '--follow', short: '-f', description: 'cmd.log.option.follow', type: 'boolean' },
    { long: '--lines', short: '-n', description: 'cmd.log.option.lines', type: 'number', default: 100 },
  ],
  handler: handleLogFollowCommand,
}
```

### 4.4 帮助文本自动生成

从 `CommandDefinition` + i18n 自动渲染帮助文本，不再手写：

```typescript
// help.ts

export function renderHelp(
  commands: readonly CommandDefinition[],
  i18n: I18n,
  version: string
): string {
  const lines: string[] = []
  lines.push(`tianji v${version}`)
  lines.push('')
  lines.push(i18n.t('help.usage_header'))  // "Usage:"
  lines.push('')

  for (const cmd of commands) {
    const usage = formatCommandUsage(cmd)
    const desc = i18n.t(cmd.description)
    lines.push(`  ${usage}`)
    lines.push(`    ${desc}`)
  }

  lines.push('')
  lines.push(i18n.t('help.global_flags_header'))  // "Global flags:"
  lines.push('  -h, --help       ' + i18n.t('help.flag.help'))
  lines.push('  -V, --version    ' + i18n.t('help.flag.version'))

  return lines.join('\n')
}

export function renderCommandHelp(
  cmd: CommandDefinition,
  i18n: I18n
): string {
  // 渲染单个命令的详细帮助：description + args + options + subcommands
}
```

**输出效果（英文）：**

```
tianji v0.0.1

Usage:

  tianji run <prompt>
    Run one prompt through the configured agent
  tianji log [--follow] [--lines <n>]
    Follow the CLI log and replay the latest lines first
  tianji daemon <subcommand>
    Manage the background daemon (start, status, stop, restart)
  tianji chat
    Connect to daemon for multi-turn chat

Global flags:
  -h, --help       Show help
  -V, --version    Show version
```

**输出效果（中文，`locale: "zh-CN"`）：**

```
tianji v0.0.1

用法:

  tianji run <prompt>
    通过配置的 agent 执行一次 prompt
  tianji log [--follow] [--lines <n>]
    跟踪 CLI 日志并回放最近的行
  tianji daemon <subcommand>
    管理后台守护进程 (start, status, stop, restart)
  tianji chat
    连接守护进程进行多轮对话

全局选项:
  -h, --help       显示帮助
  -V, --version    显示版本号
```

### 4.5 命令解析流程

```
argv
 │
 ▼
┌─────────────────────┐
│ 提取全局 flags       │  --help / -h / --version / -V
│ (在命令匹配之前拦截) │
└──────────┬──────────┘
           │ 非全局 flag
           ▼
┌─────────────────────┐
│ 匹配 command name   │  从 CommandDefinition[] 中查找
└──────────┬──────────┘
           │ 找到
           ▼
┌─────────────────────┐
│ 匹配 subcommand     │  如果 command 有 subcommands
│ (可选)               │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 解析 args + options │  按 CommandDefinition 中的声明解析
│ + flags             │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 校验必填参数         │  缺少 required arg → CliUsageError
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ 调用 handler        │  传入 CommandContext
└─────────────────────┘
```

**全局 flag 拦截示意：**

```typescript
function extractGlobalFlags(argv: readonly string[]): {
  help: boolean
  version: boolean
  commandHelp: boolean  // 如 "tianji run --help"
  remaining: string[]
} {
  // --help / -h 出现在第一个位置 → 全局帮助
  // --help / -h 出现在命令之后 → 命令级帮助
  // --version / -V → 打印版本号
}
```

### 4.6 `log` 命令语义修正

当前 `log -f` 把 `-f` 当作 positional argument，语义不清。修正为标准 flag 语法：

```bash
# Before（当前）
tianji log -f --lines 50        # -f 是 "positional"，实际是 follow 开关

# After（修正）
tianji log --follow --lines 50  # 标准长 flag
tianji log -f -n 50             # 标准短 flag
tianji log -f                   # 短 flag，lines 使用默认值 100
tianji log                      # 等价于 tianji log --follow（follow 是默认行为）
```

`--follow`/`-f` 作为 `OptionDefinition` 注册，type 为 `boolean`，默认值为 `true`（因为 `log` 命令的唯一行为就是 follow）。

### 4.7 错误消息精简

```typescript
// Before：错误消息嵌入完整 help text
throw new CliUsageError(`Missing command.\n\n${CLI_HELP_TEXT}`)

// After：错误消息精简，提示用户如何查看帮助
throw new CliUsageError(
  i18n.t('error.missing_command')
  + '\n'
  + i18n.t('error.run_help_hint')  // "Run 'tianji --help' for usage."
)
```

### 4.8 文件拆分

```
apps/cli/src/
  main.ts                    # runCli() 入口，全局 flag 拦截，命令注册表
  commands/
    types.ts                 # CommandDefinition, CommandContext 等类型
    registry.ts              # 命令注册表，所有 command 的汇总
    run.ts                   # run 命令 handler
    daemon.ts                # daemon 命令 + 4 个子命令 handler
    chat.ts                  # chat 命令 handler
    log.ts                   # log 命令 handler
    help.ts                  # 帮助文本渲染逻辑
    parse.ts                 # 通用命令解析器（从 CommandDefinition 解析 argv）
  i18n/
    index.ts                 # createI18n(), detectLocale(), 类型导出
    locales/
      en.json                # 英文翻译（基准）
      zh-CN.json             # 中文翻译
  config.ts                  # 配置加载（保持不变）
  logger.ts                  # CLI 日志（保持不变）
  log-follow.ts              # 日志跟踪逻辑（保持不变）
  daemon-entry.ts            # daemon 子进程入口（保持不变）
  dev-env.ts                 # 开发环境（保持不变）
```

## 五、i18n 国际化设计

### 5.1 整体流程

```
tianji.json (locale: "zh-CN")
        │
        ▼
  ┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
  │ detectLocale │────▶│ loadTranslations │────▶│  t(key, {}) │
  │  (config →   │     │  (read JSON file) │     │  (插值替换)  │
  │   system →   │     └──────────────────┘     └──────────────┘
  │   default)   │               │                      │
  └─────────────┘               ▼                      ▼
                        locales/zh-CN.json      "守护进程已启动 (pid=42, port=8080)"
```

### 5.2 Locale 检测策略

检测优先级（从高到低）：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 | `tianji.json` → `locale` 字段 | 用户显式配置，最高优先 |
| 2 | 操作系统 locale | 通过 `Intl.DateTimeFormat().resolvedOptions().locale` 获取 |
| 3 | 默认值 `en` | 上述都无法确定时的兜底 |

```typescript
function detectLocale(config: TianjiConfig): SupportedLocale {
  // 1. 用户显式配置
  if (config.locale !== undefined) {
    const normalized = normalizeLocale(config.locale)
    if (normalized !== undefined) return normalized
  }

  // 2. 操作系统 locale
  const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale
  const normalized = normalizeLocale(systemLocale)
  if (normalized !== undefined) return normalized

  // 3. 默认英文
  return 'en'
}
```

`normalizeLocale()` 负责将各种格式（`zh_CN`, `zh-Hans`, `zh-CN.UTF-8`）映射到支持的 locale ID。

### 5.3 翻译文件格式

采用**扁平 JSON**，key 使用 `.` 分隔的层级命名。翻译文件分为三类 key：

1. **命令描述类**（`cmd.*`）— 命令、参数、选项的描述文本，供帮助文本生成器消费
2. **运行时消息类**（`daemon.*`, `log.*`）— 命令执行过程中的输出
3. **错误类**（`error.*`）— 用法错误和运行时错误提示
4. **帮助 UI 类**（`help.*`）— 帮助文本的框架性文本（"Usage:"、"Global flags:" 等）

```jsonc
// locales/en.json
{
  // ── 帮助 UI ──────────────────────────────────────────────
  "help.usage_header": "Usage:",
  "help.global_flags_header": "Global flags:",
  "help.flag.help": "Show help",
  "help.flag.version": "Show version",
  "help.subcommands_header": "Subcommands:",

  // ── 命令描述（供帮助文本自动生成） ──────────────────────
  "cmd.run.description": "Run one prompt through the configured agent",
  "cmd.run.arg.prompt": "The prompt text to send to the agent",
  "cmd.log.description": "Follow the CLI log and replay the latest lines first",
  "cmd.log.option.follow": "Follow the log output",
  "cmd.log.option.lines": "Number of recent lines to replay",
  "cmd.daemon.description": "Manage the background daemon (start, status, stop, restart)",
  "cmd.daemon.start.description": "Start the background daemon",
  "cmd.daemon.start.option.fg": "Run in foreground instead of background",
  "cmd.daemon.status.description": "Check daemon status",
  "cmd.daemon.stop.description": "Stop the daemon",
  "cmd.daemon.restart.description": "Restart the daemon (stop + start)",
  "cmd.daemon.restart.option.fg": "Run in foreground instead of background",
  "cmd.chat.description": "Connect to daemon for multi-turn chat",

  // ── 运行时消息 ──────────────────────────────────────────
  "daemon.already_running": "Daemon already running (pid={pid})",
  "daemon.started": "Daemon started (pid={pid}, port={port})",
  "daemon.stopped": "Daemon stopped",
  "daemon.status": "Daemon running (pid={pid}, port={port}, sessionId={sessionId}, uptime={uptime}s)",
  "daemon.listening": "Daemon listening on port {port}",
  "daemon.connected": "Connected to daemon (pid={pid})",

  "log.waiting": "Waiting for CLI log file: {path}",
  "log.detected": "Detected CLI log file: {path}",
  "log.truncated": "CLI log file was truncated or recreated. Restarting from beginning.",
  "log.invalid_entry": "[invalid-cli-log] {line}",

  // ── 错误消息 ──────────────────────────────────────────
  "error.missing_command": "Missing command.",
  "error.unknown_command": "Unknown command \"{command}\".",
  "error.missing_subcommand": "Missing subcommand for \"{command}\".",
  "error.unknown_subcommand": "Unknown subcommand \"{subcommand}\" for \"{command}\".",
  "error.missing_required_arg": "Missing required argument <{arg}>.",
  "error.unexpected_args": "Unexpected arguments.",
  "error.unknown_option": "Unknown option \"{option}\".",
  "error.option_requires_value": "Option \"{option}\" requires a value.",
  "error.option_invalid_number": "Option \"{option}\" requires a valid number.",
  "error.no_daemon_running": "No daemon running. Start with: tianji daemon start",
  "error.daemon_timeout": "Timed out waiting for daemon to become ready.",
  "error.run_failed": "Run failed: {message}",
  "error.run_help_hint": "Run 'tianji --help' for usage.",
  "error.run_command_help_hint": "Run 'tianji {command} --help' for usage."
}
```

```jsonc
// locales/zh-CN.json
{
  // ── 帮助 UI ──────────────────────────────────────────────
  "help.usage_header": "用法:",
  "help.global_flags_header": "全局选项:",
  "help.flag.help": "显示帮助",
  "help.flag.version": "显示版本号",
  "help.subcommands_header": "子命令:",

  // ── 命令描述 ──────────────────────────────────────────────
  "cmd.run.description": "通过配置的 agent 执行一次 prompt",
  "cmd.run.arg.prompt": "发送给 agent 的 prompt 文本",
  "cmd.log.description": "跟踪 CLI 日志并回放最近的行",
  "cmd.log.option.follow": "跟踪日志输出",
  "cmd.log.option.lines": "回放的最近行数",
  "cmd.daemon.description": "管理后台守护进程 (start, status, stop, restart)",
  "cmd.daemon.start.description": "启动后台守护进程",
  "cmd.daemon.start.option.fg": "在前台运行而非后台",
  "cmd.daemon.status.description": "检查守护进程状态",
  "cmd.daemon.stop.description": "停止守护进程",
  "cmd.daemon.restart.description": "重启守护进程 (先停止再启动)",
  "cmd.daemon.restart.option.fg": "在前台运行而非后台",
  "cmd.chat.description": "连接守护进程进行多轮对话",

  // ── 运行时消息 ──────────────────────────────────────────
  "daemon.already_running": "守护进程已在运行 (pid={pid})",
  "daemon.started": "守护进程已启动 (pid={pid}, port={port})",
  "daemon.stopped": "守护进程已停止",
  "daemon.status": "守护进程运行中 (pid={pid}, port={port}, sessionId={sessionId}, uptime={uptime}s)",
  "daemon.listening": "守护进程正在监听端口 {port}",
  "daemon.connected": "已连接到守护进程 (pid={pid})",

  "log.waiting": "等待 CLI 日志文件: {path}",
  "log.detected": "检测到 CLI 日志文件: {path}",
  "log.truncated": "CLI 日志文件被截断或重建，从头开始读取。",
  "log.invalid_entry": "[无效日志] {line}",

  // ── 错误消息 ──────────────────────────────────────────
  "error.missing_command": "缺少命令。",
  "error.unknown_command": "未知命令 \"{command}\"。",
  "error.missing_subcommand": "缺少 \"{command}\" 的子命令。",
  "error.unknown_subcommand": "\"{command}\" 的未知子命令 \"{subcommand}\"。",
  "error.missing_required_arg": "缺少必填参数 <{arg}>。",
  "error.unexpected_args": "存在多余的参数。",
  "error.unknown_option": "未知选项 \"{option}\"。",
  "error.option_requires_value": "选项 \"{option}\" 需要一个值。",
  "error.option_invalid_number": "选项 \"{option}\" 需要一个有效的数字。",
  "error.no_daemon_running": "没有运行中的守护进程。请先执行: tianji daemon start",
  "error.daemon_timeout": "等待守护进程就绪超时。",
  "error.run_failed": "执行失败: {message}",
  "error.run_help_hint": "执行 'tianji --help' 查看用法。",
  "error.run_command_help_hint": "执行 'tianji {command} --help' 查看用法。"
}
```

**设计决策：为什么用扁平 JSON 而不是嵌套？**

- 扁平结构可以直接用 `Record<string, string>` 表示，无需递归遍历。
- key 的命名空间通过 `.` 分隔已经清晰表达层级。
- 翻译工具（翻译平台、diff 工具）对扁平格式支持更好。
- 避免嵌套带来的类型推导复杂性。

### 5.4 类型安全机制

从 `en.json`（基准语言）自动推导所有合法 key：

```typescript
// i18n/index.ts

import enMessages from './locales/en.json' with { type: 'json' }

/** 所有合法的消息 key，从英文基准 JSON 自动推导 */
export type MessageKey = keyof typeof enMessages

/** 翻译表类型：必须覆盖所有 key */
export type MessageCatalog = Record<MessageKey, string>
```

编译期保证：

1. `t('xxx')` — 如果 `xxx` 不在 `en.json` 中，TypeScript 报错。
2. 新增语言 JSON 不需要改任何 TS 类型定义。
3. `zh-CN.json` 如果缺少 key，加载时运行时 fallback 到英文。

### 5.5 插值机制

使用 `{name}` 占位符语法，运行时简单字符串替换：

```typescript
export function interpolate(
  template: string,
  params: Record<string, string | number>
): string {
  return template.replace(
    /\{(\w+)\}/g,
    (_, key) => params[key] !== undefined ? String(params[key]) : `{${key}}`
  )
}
```

- `{name}` 是 ICU MessageFormat 的子集，翻译人员熟悉。
- 命名占位符比位置占位符（`%s`）更清晰，翻译时可自由调整顺序。
- 未匹配的占位符保持原样输出，避免抛异常。

### 5.6 `t()` 函数与 `I18n` 接口

```typescript
export interface I18n {
  readonly locale: SupportedLocale
  t(key: MessageKey, params?: Record<string, string | number>): string
}

export function createI18n(locale: SupportedLocale): I18n {
  const catalog = loadCatalog(locale)

  return {
    locale,
    t(key, params) {
      const template = catalog[key] ?? enMessages[key]
      if (params === undefined) return template
      return interpolate(template, params)
    },
  }
}
```

| 特性 | 说明 |
|------|------|
| **Fallback** | 当前语言缺少 key 时自动回退到英文 |
| **惰性加载** | `loadCatalog()` 只在 `createI18n()` 时读一次 JSON |
| **不可变** | 创建后 locale 和 catalog 不会变化 |
| **可注入** | `I18n` 是接口，测试时可以传 mock 实现 |

### 5.7 翻译文件加载策略

```typescript
function loadCatalog(locale: SupportedLocale): MessageCatalog {
  if (locale === 'en') return enMessages

  // 动态导入对应 locale 的 JSON
  // 构建时所有 locale JSON 都会被打包到 dist/
  const catalog = loadLocaleJson(locale)

  // 运行时校验：缺少的 key 用英文补齐
  return { ...enMessages, ...catalog }
}
```

英文作为基准内联导入（零 I/O），其他语言按需加载。缺少的 key 自动用英文补齐，保证 `t()` 永远返回有效字符串。

## 六、Config Schema 扩展

在 `TianjiConfigSchema` 中新增顶层 `locale` 字段：

```typescript
// packages/shared/src/config.ts

export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const TianjiConfigSchema = z.object({
  locale: z.enum(SUPPORTED_LOCALES).optional(),  // 新增
  providers: TianjiProvidersConfigSchema.optional(),
  agents: TianjiAgentsConfigSchema.optional(),
  runtime: RuntimeConfigSchema.optional(),
  observer: ObserverConfigSchema.optional(),
})
```

用户在 `tianji.json` 中配置：

```json
{
  "locale": "zh-CN",
  "providers": { "..." : "..." }
}
```

不配置时走系统 locale → 默认 `en` 的 fallback 链。

## 七、集成流程

### 7.1 CLI 入口 (`main.ts`)

```typescript
export async function runCli(
  argv: readonly string[],
  deps?: RunCommandDependencies
): Promise<number> {
  loadDevelopmentEnv()

  // 1. 全局 flag 拦截（不需要 config 和 i18n）
  const globalFlags = extractGlobalFlags(argv)

  if (globalFlags.version) {
    process.stdout.write(`tianji v${VERSION}\n`)
    return 0
  }

  // 2. 初始化 i18n（在命令解析之前，让错误消息也能翻译）
  const config = await loadTianjiConfigForLocale()
  const i18n = createI18n(detectLocale(config))

  if (globalFlags.help) {
    process.stdout.write(renderHelp(COMMAND_REGISTRY, i18n, VERSION) + '\n')
    return 0
  }

  // 3. 命令解析与分发
  try {
    const { command, context } = parseCommand(
      globalFlags.remaining, COMMAND_REGISTRY, i18n, deps
    )

    if (globalFlags.commandHelp) {
      process.stdout.write(renderCommandHelp(command, i18n) + '\n')
      return 0
    }

    return await command.handler(context)
  } catch (error) {
    // ...
  }
}
```

### 7.2 Handler 改造示例

```typescript
// commands/daemon.ts

async function handleDaemonStartCommand(ctx: CommandContext): Promise<number> {
  const { i18n, options } = ctx
  const paths = getUserConfigPaths()

  const existingClient = await tryCreateDaemonClient(paths)
  if (existingClient !== undefined) {
    try {
      const ping = await existingClient.ping()
      process.stdout.write(i18n.t('daemon.already_running', { pid: ping.pid }) + '\n')
      return 0
    } catch {
      await cleanupStaleDaemonFiles(paths)
    }
  }

  if (options.fg) {
    await runDaemonEntry()
    return 0
  }

  // ... fork child process
  const { pid, port } = await waitForDaemonReady(paths)
  process.stdout.write(i18n.t('daemon.started', { pid, port }) + '\n')
  return 0
}
```

### 7.3 daemon-entry.ts 集成

daemon 进程独立运行，需要自行初始化 `I18n`：

```typescript
export async function runDaemonEntry(): Promise<void> {
  const context = await loadAgentContext()
  const i18n = createI18n(detectLocale(context.config))
  // ...
  process.stdout.write(i18n.t('daemon.listening', { port: server.port }) + '\n')
}
```

## 八、测试策略

### 8.1 命令架构测试

| 测试目标 | 覆盖点 |
|----------|--------|
| `extractGlobalFlags()` | `-h`、`--help`、`-V`、`--version`、命令后 `--help`、无 flag |
| `parseCommand()` | 正常解析、缺少必填参数、未知命令、未知选项、子命令匹配 |
| `renderHelp()` | 输出包含所有注册命令、全局 flag、版本号 |
| `renderCommandHelp()` | 输出包含 args、options、subcommands 描述 |
| 命令注册一致性 | 所有 `CommandDefinition.description` 对应的 key 在 `en.json` 中存在 |

### 8.2 i18n 测试

| 测试目标 | 覆盖点 |
|----------|--------|
| `interpolate()` | 正常替换、缺少参数保留占位符、空 params、特殊字符 |
| `detectLocale()` | config 优先、系统 locale fallback、默认 en |
| `normalizeLocale()` | `zh_CN` → `zh-CN`、`zh-Hans` → `zh-CN`、未知 locale → `undefined` |
| `createI18n().t()` | 基本翻译、插值、缺少 key fallback 到英文 |
| `loadCatalog()` | 英文直接返回、中文合并补齐 |

### 8.3 翻译完整性检查

```typescript
// __tests__/i18n-completeness.test.ts
import enMessages from '../i18n/locales/en.json'
import zhCNMessages from '../i18n/locales/zh-CN.json'

test('zh-CN covers all message keys', () => {
  const missingKeys = Object.keys(enMessages).filter(
    (key) => !(key in zhCNMessages)
  )
  expect(missingKeys).toEqual([])
})

test('all CommandDefinition description keys exist in en.json', () => {
  for (const cmd of COMMAND_REGISTRY) {
    expect(cmd.description in enMessages).toBe(true)
    // 递归检查 subcommands、args、options 的 description key
  }
})
```

### 8.4 集成测试

现有 `run-e2e.test.ts` 和 `daemon-e2e.test.ts` 通过 DI 注入 mock `I18n`，验证 handler 调用了正确的 message key，而非断言具体文案字符串。

## 九、新增语言流程

1. 在 `locales/` 下创建 `<locale>.json`，以 `en.json` 为模板翻译。
2. 在 `SUPPORTED_LOCALES` 数组中添加 locale ID。
3. 在 `normalizeLocale()` 中添加该语言的别名映射。
4. CI 自动校验 key 完整性。

无需修改 `t()` 函数、`I18n` 接口、`CommandDefinition` 或任何 handler 代码。

## 十、文件变更清单

### 新建文件

| 文件 | 职责 |
|------|------|
| `apps/cli/src/commands/types.ts` | `CommandDefinition`, `CommandContext`, `CommandHandler` 等类型 |
| `apps/cli/src/commands/registry.ts` | `COMMAND_REGISTRY` 命令注册表 |
| `apps/cli/src/commands/parse.ts` | 通用命令解析器：`extractGlobalFlags()`, `parseCommand()` |
| `apps/cli/src/commands/help.ts` | `renderHelp()`, `renderCommandHelp()` 帮助文本生成 |
| `apps/cli/src/commands/run.ts` | `runCommand` 定义 + handler |
| `apps/cli/src/commands/daemon.ts` | `daemonCommand` 定义 + 4 个子命令 handler |
| `apps/cli/src/commands/chat.ts` | `chatCommand` 定义 + handler |
| `apps/cli/src/commands/log.ts` | `logCommand` 定义 + handler |
| `apps/cli/src/i18n/index.ts` | `createI18n()`, `detectLocale()`, `normalizeLocale()`, `interpolate()` |
| `apps/cli/src/i18n/locales/en.json` | 英文翻译（基准） |
| `apps/cli/src/i18n/locales/zh-CN.json` | 中文翻译 |
| `apps/cli/src/__tests__/i18n.test.ts` | i18n 模块单元测试 |
| `apps/cli/src/__tests__/i18n-completeness.test.ts` | 翻译完整性 + 命令描述 key 校验 |
| `apps/cli/src/__tests__/commands-parse.test.ts` | 命令解析器单元测试 |
| `apps/cli/src/__tests__/commands-help.test.ts` | 帮助文本生成测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `packages/shared/src/config.ts` | `TianjiConfigSchema` 新增 `locale` 字段，导出 `SUPPORTED_LOCALES` 和 `SupportedLocale` |
| `packages/shared/src/index.ts` | 导出新增的 locale 类型 |
| `apps/cli/src/main.ts` | 精简为入口调度：全局 flag 拦截 → i18n 初始化 → 命令分发。handler 逻辑迁出至 `commands/` |
| `apps/cli/src/log-follow.ts` | `followCliLog()` 增加 `I18n` 参数，替换硬编码字符串 |
| `apps/cli/src/daemon-entry.ts` | 初始化 i18n，替换硬编码字符串 |
| `apps/cli/src/__tests__/run-e2e.test.ts` | 适配新的命令解析 API，注入 mock i18n |
| `apps/cli/src/__tests__/daemon-e2e.test.ts` | 适配新的命令解析 API，注入 mock i18n |
| `apps/cli/src/__tests__/main-daemon.test.ts` | 适配新的命令解析 API |
| `apps/cli/tsconfig.build.json` | 确保 `resolveJsonModule` 启用，JSON 文件包含在构建输出中 |
| `apps/cli/package.json` | 版本号字段供 `--version` 读取 |

## 十一、现有文档更新

本次重构涉及 CLI 命令架构变更、配置 schema 扩展和 i18n 新增模块，需要同步更新以下现有文档，确保文档与实现保持一致。

### 11.1 `docs/CONFIG_DESIGN.md`

**原因**：配置 schema 新增 `locale` 顶层字段，需要更新配置结构说明。

| 章节 | 变更内容 |
|------|---------|
| §8 顶层配置结构 | 开头说明从"四个顶层字段"改为"五个顶层字段：`locale`、`providers`、`agents`、`runtime`、`observer`" |
| §8（新增 §8.0 locale） | 新增 `locale` 字段说明：类型为 `SupportedLocale`（`'en' \| 'zh-CN'`），可选，未配置时走系统 locale → 默认 `en` 的 fallback 链。说明该字段不参与 `${env:}` 占位符解析 |
| §8 JSON 示例 | 在顶层 JSON 示例中添加 `"locale": "zh-CN"` 字段 |
| §12 默认配置 | `DEFAULT_TIANJI_CONFIG` 示例中无需添加 locale（因为默认为 `undefined`，走 fallback），但需添加注释说明 locale 的缺省行为 |

### 11.2 `docs/ARCHITECTURE_V2.md`

**原因**：CLI 层职责发生重大变化——从手写解析变为声明式命令注册，新增 i18n 模块。

| 章节 | 变更内容 |
|------|---------|
| §3.4 `@tianji/cli` — L3 UI 层 → 职责 | 更新职责列表：将 "CLI 参数解析（`parseCliArgs`）" 改为 "声明式命令注册与解析（`commands/`）"；将 "`tianji run` / `tianji log -f` 命令路由" 改为 "`tianji run` / `tianji log` / `tianji daemon` / `tianji chat` 命令路由与全局 flag（`-h`/`--help`、`-V`/`--version`）拦截"；新增 "i18n 国际化（`i18n/`，翻译文件加载、locale 检测、消息插值）" |
| §3.4 变化要点 | 新增要点："`main.ts` 拆分为 `commands/` 目录（声明式命令定义 + handler）和精简的入口调度"；新增要点："新增 `i18n/` 模块，所有用户可见字符串从硬编码改为 JSON 翻译文件 + `t()` 函数" |
| §6.3 cli 配置逻辑 → agent | 在"CLI 中保留的内容"列表中，将 "`parseCliArgs`（CLI 特有）" 更新为 "`commands/` 声明式命令注册与解析（CLI 特有）"；新增 "`i18n/` 国际化模块（CLI 特有）" |

### 11.3 更新原则

- **增量更新**：只修改受本次变更直接影响的章节，不重写整篇文档。
- **前向引用**：在被更新的文档中添加指向本设计文档的链接，便于追溯设计决策。
- **时间戳**：在每个被修改文档的头部 metadata 中更新日期或添加变更记录。
- **实现后更新**：文档更新应在代码实现完成并通过测试后进行，避免文档与实现不同步。
