# CLI 命令架构重构与 i18n Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `@tianji/cli` 落地声明式命令注册、帮助文本自动生成和 `en`/`zh-CN` 双语 i18n 能力，同时完成配置 schema 扩展、测试回归和受影响文档更新。

**Architecture:** 保持 `apps/cli` 作为薄 UI 层，把 `main.ts` 收敛为入口调度，只负责开发环境初始化、全局 flag 拦截、i18n 初始化、命令分发和错误出口。命令定义、帮助渲染、参数解析与运行时文案全部拆到 `commands/` 和 `i18n/` 模块，通过 `CommandDefinition` + `I18n` 把命令元信息、帮助输出和用户可见字符串统一起来。

**Tech Stack:** TypeScript, Node.js ESM, JSON modules, Vitest, `pnpm`, `@tianji/agent`, `@tianji/shared`

---

### 文件结构

**Create:**
- `apps/cli/src/commands/types.ts`: 声明 `CommandDefinition`、`CommandContext`、`ArgumentDefinition`、`OptionDefinition`、解析结果类型和帮助渲染依赖类型。
- `apps/cli/src/commands/registry.ts`: 聚合顶层命令定义，导出 `COMMAND_REGISTRY` 和帮助命令查找辅助函数。
- `apps/cli/src/commands/parse.ts`: 实现 `extractGlobalFlags()`、`parseCommand()`、命令匹配、参数和选项解析、命令级帮助识别。
- `apps/cli/src/commands/help.ts`: 实现 `renderHelp()`、`renderCommandHelp()`、usage 拼接与全局 flag 文案渲染。
- `apps/cli/src/commands/run.ts`: `run` 命令定义与 handler。
- `apps/cli/src/commands/daemon.ts`: `daemon` 命令定义与 `start` / `status` / `stop` / `restart` 子命令 handler。
- `apps/cli/src/commands/chat.ts`: `chat` 命令定义与 handler。
- `apps/cli/src/commands/log.ts`: `log` 命令定义与 handler，修正 `--follow` / `-f` / `--lines` / `-n` 语义。
- `apps/cli/src/i18n/index.ts`: `SupportedLocale` 适配、`MessageKey`、`I18n`、`createI18n()`、`detectLocale()`、`normalizeLocale()`、`interpolate()`、catalog 加载。
- `apps/cli/src/i18n/locales/en.json`: 英文基准翻译表。
- `apps/cli/src/i18n/locales/zh-CN.json`: 中文翻译表。
- `apps/cli/src/__tests__/i18n.test.ts`: i18n 模块单元测试。
- `apps/cli/src/__tests__/i18n-completeness.test.ts`: 翻译完整性和命令 description key 校验。
- `apps/cli/src/__tests__/commands-parse.test.ts`: 全局 flag、命令匹配、args/options 解析测试。
- `apps/cli/src/__tests__/commands-help.test.ts`: 帮助文本生成测试。
- `apps/cli/src/__tests__/commands-e2e.test.ts`: 命令调度、locale 切换、命令行为回归 e2e 测试。

**Modify:**
- `packages/shared/src/config.ts`: 新增 `SUPPORTED_LOCALES`、`SupportedLocale` 和 `TianjiConfigSchema.locale`。
- `packages/shared/src/index.ts`: 重新导出 locale 类型和常量。
- `apps/cli/src/main.ts`: 删掉手写命令 union / help 常量 / if-else 解析，改为新入口调度。
- `apps/cli/src/log-follow.ts`: 注入 `I18n`，替换用户可见硬编码字符串。
- `apps/cli/src/daemon-entry.ts`: 初始化 i18n，替换用户可见硬编码字符串。
- `apps/cli/src/__tests__/run-e2e.test.ts`: 只保留 `run` 和 `log` 的行为回归，适配新的 `runCli()` 初始化和 log follow 调用。
- `apps/cli/src/__tests__/daemon-e2e.test.ts`: 只保留 daemon 真正的启动/状态/停止链路回归，适配新的依赖注入方式。
- `apps/cli/src/__tests__/main-daemon.test.ts`: 只覆盖 daemon 调度边界、命令级帮助和错误出口，从旧 `parseCliArgs()` 迁移到新解析器 API。
- `apps/cli/src/__tests__/helpers/cli-test-utils.ts`: 补充 `createDepsWithLocale()` locale 注入工厂、mock i18n 和 stdout 捕获工具。
- `apps/cli/tsconfig.build.json`: 确认 `resolveJsonModule` / JSON 输出策略满足 locale 文件构建要求。
- `apps/cli/package.json`: 确认 `version` 为 `--version` 的读取来源，并在需要时补充导出说明。
- `apps/cli/README.md`: 更新命令列表、帮助方式、locale 配置、`log` 新语义。
- `docs/CONFIG_DESIGN.md`: 增量补充 `locale` 顶层字段说明，并前向引用 spec。
- `docs/ARCHITECTURE_V2.md`: 增量更新 CLI 职责描述、`commands/` 和 `i18n/` 模块说明，并前向引用 spec。

**Verify Before Editing:**
- `apps/cli/src/main.ts`: 识别当前 `run` / `daemon` / `chat` / `log` handler 内复用逻辑，避免计划里假设不存在的抽象。
- `apps/cli/src/log-follow.ts`: 当前直接写 stdout 的文本位置需要全部纳入 i18n。
- `apps/cli/src/daemon-entry.ts`: 当前 daemon 启动消息输出点只有一个，计划中的 i18n 改造要保持最小化。
- `apps/cli/README.md`: 现有 README 还保留 `status` / `stop` 顶层命令，需要在实现完成后一起收口。
- `apps/cli/package.json` 与现有 build 入口: 先确认当前版本号读取方式和 JSON module 使用方式，优先复用已有模式，不提前假设导入路径或构建行为。

**Execution Notes Before Coding:**
- `detectLocale()` 必须严格遵循 spec：`config.locale -> Intl.DateTimeFormat().resolvedOptions().locale -> 'en'`。本计划不引入 `LANG`、`LC_ALL`、`LC_MESSAGES` 环境变量读取逻辑。
- `log` 命令本阶段保持 `follow: true` 默认行为，`--follow` 仅作为语义规范化和未来扩展预留，不实现关闭 follow 的模式。
- 新增 `commands-e2e.test.ts` 只负责顶层命令调度、locale 切换、help/version/error matrix；不要和 `run-e2e.test.ts`、`daemon-e2e.test.ts`、`main-daemon.test.ts` 重复覆盖同一职责。

### Task 1: 扩展 shared 配置 schema，先锁定 locale 类型边界

**Files:**
- Modify: `packages/shared/src/config.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/config.ts` 对应现有测试文件；若仓库无专门 shared config 测试文件，则在 `packages/shared` 下新增最小测试文件并在本任务中一并落地

- [ ] **Step 1: 先定位 shared 配置测试入口并写失败测试，锁定 `locale` schema 行为**

```ts
it('accepts locale at top level of Tianji config', () => {
  const result = TianjiConfigSchema.safeParse({
    locale: 'zh-CN',
    providers: {},
  })

  expect(result.success).toBe(true)
})

it('rejects unsupported locale values', () => {
  const result = TianjiConfigSchema.safeParse({
    locale: 'fr-FR',
  })

  expect(result.success).toBe(false)
})

it('exports supported locales in shared public API', () => {
  expect(SUPPORTED_LOCALES).toEqual(['en', 'zh-CN'])
})
```

- [ ] **Step 2: 运行 shared 定向测试，确认当前失败**

Run: `pnpm --filter @tianji/shared test -- config`
Expected: FAIL，提示 `locale` 字段不存在或 `SUPPORTED_LOCALES` 未导出

- [ ] **Step 3: 在 shared config schema 中增加 locale 常量、类型和 schema 字段**

```ts
export const SUPPORTED_LOCALES = ['en', 'zh-CN'] as const

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const TianjiConfigSchema = z.object({
  locale: z.enum(SUPPORTED_LOCALES).optional(),
  providers: TianjiProvidersConfigSchema.optional(),
  agents: TianjiAgentsConfigSchema.optional(),
  runtime: RuntimeConfigSchema.optional(),
  observer: ObserverConfigSchema.optional(),
})
```

- [ ] **Step 4: 从 `packages/shared/src/index.ts` 重新导出 locale 公共 API**

```ts
export {
  SUPPORTED_LOCALES,
  type SupportedLocale,
  TianjiConfigSchema,
  type TianjiConfig,
} from './config.js'
```

- [ ] **Step 5: 重跑 shared 定向测试，确认 schema 契约成立**

Run: `pnpm --filter @tianji/shared test -- config`
Expected: PASS

- [ ] **Step 6: 提交 shared locale schema 改造**

```bash
git add packages/shared/src/config.ts packages/shared/src/index.ts packages/shared/src/**/*.test.ts
git commit -m "feat(shared): add locale to tianji config schema"
```

### Task 2: 先用 TDD 落地 i18n 基础模块

**Files:**
- Create: `apps/cli/src/i18n/index.ts`
- Create: `apps/cli/src/i18n/locales/en.json`
- Create: `apps/cli/src/i18n/locales/zh-CN.json`
- Create: `apps/cli/src/__tests__/i18n.test.ts`

- [ ] **Step 1: 先写 i18n 单测，覆盖 locale 归一化、插值、fallback 和 config/system locale 优先级**

```ts
describe('normalizeLocale', () => {
  it.each([
    ['en', 'en'],
    ['en-US', 'en'],
    ['zh_CN', 'zh-CN'],
    ['zh-CN.UTF-8', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh-SG', 'zh-CN'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected)
  })

  it('returns undefined for unsupported locales', () => {
    expect(normalizeLocale('fr-FR')).toBeUndefined()
  })

  it('does not map traditional chinese variants to zh-CN', () => {
    expect(normalizeLocale('zh-TW')).toBeUndefined()
    expect(normalizeLocale('zh-Hant')).toBeUndefined()
    expect(normalizeLocale('zh-HK')).toBeUndefined()
  })
})

describe('detectLocale', () => {
  it('prefers explicit config locale', () => {
    expect(detectLocale({ locale: 'zh-CN' })).toBe('zh-CN')
  })

  it('falls back to Intl API when config has no locale', () => {
    const spy = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockReturnValue({ resolvedOptions: () => ({ locale: 'zh-CN' }) } as Intl.DateTimeFormat)

    try {
      expect(detectLocale({})).toBe('zh-CN')
    } finally {
      spy.mockRestore()
    }
  })

  it('defaults to en when no locale signal is available', () => {
    const spy = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockReturnValue({ resolvedOptions: () => ({ locale: 'fr-FR' }) } as Intl.DateTimeFormat)

    try {
      expect(detectLocale({})).toBe('en')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('createI18n', () => {
  it('renders translated messages with interpolation', () => {
    const i18n = createI18n('zh-CN')

    expect(i18n.t('daemon.started', { pid: 42, port: 8080 })).toBe(
      '守护进程已启动 (pid=42, port=8080)'
    )
  })

  it('falls back to english when locale catalog is missing a key', () => {
    const i18n = createI18n('zh-CN')

    expect(i18n.t('help.flag.version')).toBeTruthy()
  })
})

describe('interpolate', () => {
  it('keeps missing placeholders intact', () => {
    expect(interpolate('hello {name} {missing}', { name: 'cli' })).toBe('hello cli {missing}')
  })
})
```

- [ ] **Step 2: 运行 CLI i18n 定向测试，确认模块当前缺失**

Run: `pnpm --filter @tianji/cli test -- src/__tests__/i18n.test.ts`
Expected: FAIL，提示 `../i18n/index.js` 或 JSON locale 文件不存在

- [ ] **Step 3: 创建英文基准翻译表，先只写 spec 明确要求的 key**

```json
{
  "help.usage_header": "Usage:",
  "help.global_flags_header": "Global flags:",
  "help.flag.help": "Show help",
  "help.flag.version": "Show version",
  "help.subcommands_header": "Subcommands:",
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

- [ ] **Step 4: 创建中文翻译表，与英文 key 完全对齐**

```json
{
  "help.usage_header": "用法:",
  "help.global_flags_header": "全局选项:",
  "help.flag.help": "显示帮助",
  "help.flag.version": "显示版本号",
  "help.subcommands_header": "子命令:",
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

- [ ] **Step 5: 实现 i18n 模块最小逻辑，类型直接从 `en.json` 推导**

```ts
import type { TianjiConfig, SupportedLocale } from '@tianji/shared'
import enMessages from './locales/en.json' with { type: 'json' }
import zhCNMessages from './locales/zh-CN.json' with { type: 'json' }

export type MessageKey = keyof typeof enMessages
export type MessageCatalog = Record<MessageKey, string>

export interface I18n {
  readonly locale: SupportedLocale
  t(key: MessageKey, params?: Record<string, string | number>): string
}

export function interpolate(
  template: string,
  params: Record<string, string | number>
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    params[key] !== undefined ? String(params[key]) : `{${key}}`
  )
}

const ZH_CN_VARIANTS = new Set(['zh-cn', 'zh-hans', 'zh-sg'])

export function normalizeLocale(locale: string): SupportedLocale | undefined {
  const normalized = locale.replace(/_/g, '-').split('.')[0].toLowerCase()
  if (normalized === 'en' || normalized.startsWith('en-')) {
    return 'en'
  }
  if (ZH_CN_VARIANTS.has(normalized)) {
    return 'zh-CN'
  }
  return undefined
}

export function detectLocale(config: Pick<TianjiConfig, 'locale'>): SupportedLocale {
  if (config.locale !== undefined) {
    return config.locale
  }

  const systemLocale = normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale)
  return systemLocale ?? 'en'
}

function loadCatalog(locale: SupportedLocale): MessageCatalog {
  if (locale === 'en') {
    return enMessages
  }

  return {
    ...enMessages,
    ...zhCNMessages,
  }
}

export function createI18n(locale: SupportedLocale): I18n {
  const catalog = loadCatalog(locale)

  return {
    locale,
    t(key, params) {
      const template = catalog[key] ?? enMessages[key]
      return params === undefined ? template : interpolate(template, params)
    },
  }
}
```

- [ ] **Step 6: 重跑 i18n 单测，确认基础模块通过**

Run: `pnpm --filter @tianji/cli test -- src/__tests__/i18n.test.ts`
Expected: PASS

- [ ] **Step 7: 提交 i18n 基础模块**

```bash
git add apps/cli/src/i18n apps/cli/src/__tests__/i18n.test.ts
git commit -m "feat(cli): add i18n foundation for user-facing messages"
```

### Task 3: 为声明式命令系统先写解析器测试，再创建命令元数据类型

**Files:**
- Create: `apps/cli/src/commands/types.ts`
- Create: `apps/cli/src/commands/parse.ts`
- Create: `apps/cli/src/__tests__/commands-parse.test.ts`

- [ ] **Step 1: 先写解析器失败测试，覆盖全局帮助、版本、命令级帮助、args/options 校验**

```ts
describe('extractGlobalFlags', () => {
  it('recognizes top-level help and version flags', () => {
    expect(extractGlobalFlags(['--help'])).toEqual({
      help: true,
      version: false,
      commandHelp: false,
      remaining: [],
    })

    expect(extractGlobalFlags(['-V'])).toEqual({
      help: false,
      version: true,
      commandHelp: false,
      remaining: [],
    })
  })

  it('recognizes command help when help appears after a command token', () => {
    expect(extractGlobalFlags(['run', '--help'])).toEqual({
      help: false,
      version: false,
      commandHelp: true,
      remaining: ['run'],
    })
  })
})

describe('parseCommand', () => {
  it('parses run prompt positional argument', () => {
    const result = parseCommand(['run', 'hello'], COMMAND_REGISTRY, createI18n('en'))

    expect(result.command.name).toBe('run')
    expect(result.context.args).toEqual({ prompt: 'hello' })
  })

  it('parses log options and defaults follow to true', () => {
    const result = parseCommand(['log', '-n', '20'], COMMAND_REGISTRY, createI18n('en'))

    expect(result.context.options).toEqual({
      follow: true,
      lines: 20,
    })
  })

  it('rejects unknown commands with translated usage hint', () => {
    expect(() => parseCommand(['wat'], COMMAND_REGISTRY, createI18n('en'))).toThrow(
      /Unknown command "wat"/i
    )
  })
})
```

- [ ] **Step 2: 运行解析器测试，确认新模块缺失**

Run: `pnpm --filter @tianji/cli test -- src/__tests__/commands-parse.test.ts`
Expected: FAIL，提示 `commands/parse.ts` 或 `commands/types.ts` 缺失

- [ ] **Step 3: 实现命令元数据类型，避免后续文件继续猜类型**

```ts
import type { SupportedLocale } from '@tianji/shared'

import type { I18n, MessageKey } from '../i18n/index.js'

/**
 * 从原 RunCommandDependencies 改名为 CliDependencies，涵盖所有命令的可注入依赖。
 * 各命令按需取用，不再绑定到 run 命令。
 */
export interface CliDependencies {
  readonly loadContext?: () => Promise<LoadedAgentContext>
  readonly createSession?: (context: LoadedAgentContext) => AgentSession
  readonly getUserConfigPaths?: () => UserConfigPaths
  readonly followCliLog?: (logFilePath: string, i18n: I18n, options?: FollowCliLogOptions) => Promise<void>
  readonly writeStdout?: (message: string) => void
  readonly runDaemonEntry?: () => Promise<void>
  readonly loadConfig?: () => Promise<Partial<TianjiConfig>>
}

export interface ArgumentDefinition {
  readonly name: string
  readonly description: MessageKey
  readonly required: boolean
}

export interface OptionDefinition {
  readonly long: `--${string}`
  readonly short?: `-${string}`
  readonly description: MessageKey
  readonly type: 'string' | 'number' | 'boolean'
  readonly default?: string | number | boolean
}

export interface CommandContext {
  readonly args: Record<string, string>
  readonly options: Record<string, string | number | boolean>
  readonly i18n: I18n
  readonly deps: CliDependencies | undefined
}

export type CommandHandler = (context: CommandContext) => Promise<number>

export interface CommandDefinition {
  readonly name: string
  readonly description: MessageKey
  readonly args?: readonly ArgumentDefinition[]
  readonly options?: readonly OptionDefinition[]
  readonly subcommands?: readonly CommandDefinition[]
  readonly handler: CommandHandler
}

export interface ParsedCommandResult {
  readonly command: CommandDefinition
  readonly context: CommandContext
}
```

> **Note:** `CliDependencies.followCliLog` 签名已包含 `i18n` 参数，与 Task 6 中 `log-follow.ts` 的改造对齐。`loadConfig` 用于 e2e 测试注入 locale 配置（见 Task 7），运行时实现应优先复用现有最小配置加载入口，不在计划里预设不存在的 API 名称。

- [ ] **Step 4: 实现全局 flag 提取和通用解析器，只覆盖测试已要求的最小集合**

```ts
/**
 * 全局 flag 提取规则：
 * - `tianji --help` / `tianji -h` / `tianji help` → 全局帮助
 * - `tianji --version` / `tianji -V` → 版本号（任何位置出现即生效，优先级最高）
 * - `tianji <command> --help` → 命令级帮助
 * - `tianji help <command>` → 等价于 `tianji <command> --help`
 * - 本次不支持 `--lang`/`--locale` CLI flag 级别的 locale 覆盖
 */
export function extractGlobalFlags(argv: readonly string[]): {
  help: boolean
  version: boolean
  commandHelp: boolean
  remaining: string[]
} {
  // --version / -V 优先级最高，无论位置
  if (argv.includes('--version') || argv.includes('-V')) {
    return { help: false, version: true, commandHelp: false, remaining: [] }
  }

  // 仅首个 token 为 help flag 时视为全局帮助
  if (argv.length >= 1 && (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')) {
    // `tianji help daemon` → 命令级帮助
    if (argv[0] === 'help' && argv.length > 1) {
      return { help: false, version: false, commandHelp: true, remaining: argv.slice(1) }
    }
    return { help: true, version: false, commandHelp: false, remaining: [] }
  }

  // 命令级帮助：help flag 出现在命令 token 之后
  const remaining = argv.filter((arg) => arg !== '--help' && arg !== '-h')
  const commandHelp = remaining.length !== argv.length

  return {
    help: false,
    version: false,
    commandHelp,
    remaining,
  }
}
```

- [ ] **Step 5: 重跑解析器测试，确认命令骨架可用**

Run: `pnpm --filter @tianji/cli test -- src/__tests__/commands-parse.test.ts`
Expected: PASS

- [ ] **Step 6: 提交命令解析基础设施**

```bash
git add apps/cli/src/commands/types.ts apps/cli/src/commands/parse.ts apps/cli/src/__tests__/commands-parse.test.ts
git commit -m "feat(cli): add declarative command parsing core"
```

### Task 4: 用帮助文本测试驱动命令注册表和帮助渲染器

**Files:**
- Create: `apps/cli/src/commands/help.ts`
- Create: `apps/cli/src/commands/registry.ts`
- Create: `apps/cli/src/__tests__/commands-help.test.ts`

- [ ] **Step 1: 写帮助文本失败测试，锁定全局 help、命令级 help、双语输出结构**

```ts
describe('renderHelp', () => {
  it('renders all top-level commands and global flags', () => {
    const output = renderHelp(COMMAND_REGISTRY, createI18n('en'), '0.0.1')

    expect(output).toContain('tianji v0.0.1')
    expect(output).toContain('tianji run <prompt>')
    expect(output).toContain('tianji daemon <subcommand>')
    expect(output).toContain('-h, --help')
    expect(output).toContain('-V, --version')
  })

  it('renders chinese help with translated headers', () => {
    const output = renderHelp(COMMAND_REGISTRY, createI18n('zh-CN'), '0.0.1')

    expect(output).toContain('用法:')
    expect(output).toContain('全局选项:')
  })
})

describe('renderCommandHelp', () => {
  it('renders daemon subcommands and descriptions', () => {
    const daemon = COMMAND_REGISTRY.find((command) => command.name === 'daemon')!
    const output = renderCommandHelp(daemon, createI18n('en'))

    expect(output).toContain('Subcommands:')
    expect(output).toContain('start')
    expect(output).toContain('restart')
  })
})
```

- [ ] **Step 2: 运行帮助文本测试，确认渲染器和注册表尚未实现**

Run: `pnpm --filter @tianji/cli test -- src/__tests__/commands-help.test.ts`
Expected: FAIL

- [ ] **Step 3: 建立顶层命令注册表，先用最小占位 handler 让帮助测试可运行**

```ts
const unsupportedHandler: CommandHandler = async () => {
  throw new Error('handler not implemented yet')
}

export const COMMAND_REGISTRY: readonly CommandDefinition[] = [
  {
    name: 'run',
    description: 'cmd.run.description',
    args: [{ name: 'prompt', description: 'cmd.run.arg.prompt', required: true }],
    handler: unsupportedHandler,
  },
  {
    name: 'log',
    description: 'cmd.log.description',
    options: [
      { long: '--follow', short: '-f', description: 'cmd.log.option.follow', type: 'boolean', default: true },
      { long: '--lines', short: '-n', description: 'cmd.log.option.lines', type: 'number', default: 100 },
    ],
    handler: unsupportedHandler,
  },
  {
    name: 'daemon',
    description: 'cmd.daemon.description',
    subcommands: [
      {
        name: 'start',
        description: 'cmd.daemon.start.description',
        options: [{ long: '--fg', description: 'cmd.daemon.start.option.fg', type: 'boolean' }],
        handler: unsupportedHandler,
      },
      { name: 'status', description: 'cmd.daemon.status.description', handler: unsupportedHandler },
      { name: 'stop', description: 'cmd.daemon.stop.description', handler: unsupportedHandler },
      {
        name: 'restart',
        description: 'cmd.daemon.restart.description',
        options: [{ long: '--fg', description: 'cmd.daemon.restart.option.fg', type: 'boolean' }],
        handler: unsupportedHandler,
      },
    ],
    handler: unsupportedHandler,
  },
  {
    name: 'chat',
    description: 'cmd.chat.description',
    handler: unsupportedHandler,
  },
]
```

- [ ] **Step 4: 实现帮助渲染函数，确保 usage 从注册表推导**

```ts
export function renderHelp(
  commands: readonly CommandDefinition[],
  i18n: I18n,
  version: string
): string {
  const lines: string[] = [`tianji v${version}`, '', i18n.t('help.usage_header'), '']

  for (const command of commands) {
    lines.push(`  ${formatCommandUsage(command)}`)
    lines.push(`    ${i18n.t(command.description)}`)
  }

  lines.push('')
  lines.push(i18n.t('help.global_flags_header'))
  lines.push(`  -h, --help       ${i18n.t('help.flag.help')}`)
  lines.push(`  -V, --version    ${i18n.t('help.flag.version')}`)

  return lines.join('\n')
}
```

- [ ] **Step 5: 重跑帮助文本测试，确认自动生成符合预期**

Run: `pnpm --filter @tianji/cli test -- src/__tests__/commands-help.test.ts`
Expected: PASS

- [ ] **Step 6: 提交帮助渲染与命令注册表**

```bash
git add apps/cli/src/commands/help.ts apps/cli/src/commands/registry.ts apps/cli/src/__tests__/commands-help.test.ts
git commit -m "feat(cli): generate help text from command registry"
```

### Task 5: 迁移 `run` / `log` / `chat` 命令到声明式模块并保持现有集成测试通过

**Files:**
- Create: `apps/cli/src/commands/run.ts`
- Create: `apps/cli/src/commands/log.ts`
- Create: `apps/cli/src/commands/chat.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/__tests__/run-e2e.test.ts`

- [ ] **Step 1: 先在现有 `run-e2e.test.ts` 中增加失败断言，只锁定 `run` / `log` 新语义，不重复覆盖顶层调度矩阵**

```ts
it('treats log without explicit follow flag as follow by default', async () => {
  const followSpy = vi.fn(async () => undefined)

  await runCli(['log'], {
    followCliLog: followSpy,
    getUserConfigPaths: () => createFakeContext().paths,
  })

  expect(followSpy).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(Object),
    expect.objectContaining({ lines: 100 })
  )
})

it('passes follow=true when log is invoked without explicit flag', async () => {
  const followSpy = vi.fn(async () => undefined)

  await runCli(['log'], {
    followCliLog: followSpy,
    getUserConfigPaths: () => createFakeContext().paths,
  })

  expect(followSpy).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(Object),
    expect.objectContaining({ lines: 100 })
  )
})
```

- [ ] **Step 2: 运行 run e2e 测试，确认 `log` 默认行为和新调用签名当前失败**

Run: `pnpm --filter @tianji/cli test -- src/__tests__/run-e2e.test.ts`
Expected: FAIL，`log` 默认行为或 `followCliLog` 新签名尚未适配

- [ ] **Step 3: 把现有 `run`、`log`、`chat` 逻辑搬到独立命令模块，保持依赖注入接口不变**

```ts
export const runCommand: CommandDefinition = {
  name: 'run',
  description: 'cmd.run.description',
  args: [{ name: 'prompt', description: 'cmd.run.arg.prompt', required: true }],
  handler: async ({ args, deps, i18n }) => {
    const prompt = args.prompt
    // 直接复用 main.ts 现有 run handler 逻辑
    return handleRunPrompt(prompt, deps, i18n)
  },
}

export const logCommand: CommandDefinition = {
  name: 'log',
  description: 'cmd.log.description',
  options: [
    { long: '--follow', short: '-f', description: 'cmd.log.option.follow', type: 'boolean', default: true },
    { long: '--lines', short: '-n', description: 'cmd.log.option.lines', type: 'number', default: 100 },
  ],
  handler: async ({ options, deps, i18n }) => {
    return handleLogCommand(options, deps, i18n)
  },
}

export const chatCommand: CommandDefinition = {
  name: 'chat',
  description: 'cmd.chat.description',
  handler: async ({ deps, i18n }) => {
    return handleChatCommand(deps, i18n)
  },
}
```

- [ ] **Step 4: 重写 `main.ts` 入口，只保留调度、i18n 初始化、统一错误出口**

```ts
export async function runCli(
  argv: readonly string[],
  deps?: CliDependencies
): Promise<number> {
  loadDevelopmentEnv()

  const globalFlags = extractGlobalFlags(argv)
  if (globalFlags.version) {
    process.stdout.write(`tianji v${VERSION}\n`)
    return 0
  }

  // 支持 deps.loadConfig 注入，e2e 测试可通过此注入 locale
  const config = deps?.loadConfig
    ? await deps.loadConfig().catch(() => ({}))
    : await loadCurrentCliConfig().catch(() => ({}))
  const i18n = createI18n(detectLocale(config))

  if (globalFlags.help) {
    process.stdout.write(renderHelp(COMMAND_REGISTRY, i18n, VERSION) + '\n')
    return 0
  }

  try {
    const parsed = parseCommand(globalFlags.remaining, COMMAND_REGISTRY, i18n, deps)

    if (globalFlags.commandHelp) {
      process.stdout.write(renderCommandHelp(parsed.command, i18n) + '\n')
      return 0
    }

    return await parsed.command.handler(parsed.context)
  } catch (error) {
    return handleCliError(error)
  }
}
```

> **Note:** `loadCurrentCliConfig()` 只是计划中的占位名。实现时必须先核实现有 `main.ts` / config 模块的最小配置读取入口，优先复用已有逻辑，不要为了 plan 强行引入新的配置抽象。

- [ ] **Step 5: 重跑 `run-e2e`，确认主流程和新全局 flag 都通过**

Run: `pnpm --filter @tianji/cli test -- src/__tests__/run-e2e.test.ts`
Expected: PASS

- [ ] **Step 6: 提交 `run` / `log` / `chat` 命令模块化改造**

```bash
git add apps/cli/src/main.ts apps/cli/src/commands/run.ts apps/cli/src/commands/log.ts apps/cli/src/commands/chat.ts apps/cli/src/__tests__/run-e2e.test.ts
git commit -m "feat(cli): move run log and chat into command modules"
```

### Task 6: 迁移 `daemon` 命令并把 daemon / log 用户文案接入 i18n

**Files:**
- Create: `apps/cli/src/commands/daemon.ts`
- Modify: `apps/cli/src/log-follow.ts`
- Modify: `apps/cli/src/daemon-entry.ts`
- Modify: `apps/cli/src/__tests__/daemon-e2e.test.ts`
- Modify: `apps/cli/src/__tests__/main-daemon.test.ts`

- [ ] **Step 1: 先给 daemon 测试补失败断言，覆盖命令级帮助和翻译化错误消息**

```ts
it('shows daemon command help through help flag', async () => {
  const output = await captureStdout(async () => {
    const exitCode = await runCli(['daemon', '--help'])
    expect(exitCode).toBe(0)
  })

  expect(output).toContain('tianji daemon <subcommand>')
  expect(output).toContain('start')
  expect(output).toContain('--fg')
})

it('returns translated usage error without embedding full help text', async () => {
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

  const exitCode = await runCli(['daemon'])

  expect(exitCode).toBe(2)
  expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/Missing subcommand/))
  expect(stderr).toHaveBeenCalledWith(expect.not.stringMatching(/tianji run <prompt>/))
})
```

- [ ] **Step 2: 运行 daemon 相关测试，确认当前失败**

Run: `pnpm --filter @tianji/cli test -- src/__tests__/main-daemon.test.ts src/__tests__/daemon-e2e.test.ts`
Expected: FAIL

- [ ] **Step 3: 把 daemon 子命令逻辑迁入 `commands/daemon.ts`，保留 `runDaemonEntry` 注入点和现有真实集成链路**

```ts
export const daemonCommand: CommandDefinition = {
  name: 'daemon',
  description: 'cmd.daemon.description',
  subcommands: [
    {
      name: 'start',
      description: 'cmd.daemon.start.description',
      options: [{ long: '--fg', description: 'cmd.daemon.start.option.fg', type: 'boolean' }],
      handler: handleDaemonStartCommand,
    },
    { name: 'status', description: 'cmd.daemon.status.description', handler: handleDaemonStatusCommand },
    { name: 'stop', description: 'cmd.daemon.stop.description', handler: handleDaemonStopCommand },
    {
      name: 'restart',
      description: 'cmd.daemon.restart.description',
      options: [{ long: '--fg', description: 'cmd.daemon.restart.option.fg', type: 'boolean' }],
      handler: handleDaemonRestartCommand,
    },
  ],
  handler: async () => {
    throw new Error('daemon requires subcommand')
  },
}
```

- [ ] **Step 4: 在 `log-follow.ts` 和 `daemon-entry.ts` 中注入 `I18n` 并替换用户可见字符串**

> **Important:** `followCliLog` 签名变更（插入 `i18n` 参数）后，必须同步更新：
> - `CliDependencies.followCliLog` 的类型定义（已在 Task 3 types.ts 中预置）
> - `commands/log.ts` handler 中的调用方式
> - 所有现有测试中 mock `followCliLog` 的签名

```ts
export async function followCliLog(
  logFilePath: string,
  i18n: I18n,
  options: FollowCliLogOptions = {}
): Promise<void> {
  if (!hasPrintedWaitingMessage) {
    process.stdout.write(i18n.t('log.waiting', { path: logFilePath }) + '\n')
  }

  process.stdout.write(i18n.t('log.detected', { path: logFilePath }) + '\n')
  process.stdout.write(i18n.t('log.truncated') + '\n')
}

export async function runDaemonEntry(): Promise<void> {
  const context = await loadAgentContext()
  const i18n = createI18n(detectLocale(context.config))
  // ...
  process.stdout.write(i18n.t('daemon.listening', { port: server.port }) + '\n')
}
```

- [ ] **Step 5: 重跑 daemon 相关测试，确认 daemon 路径和 i18n 替换都稳定**

Run: `pnpm --filter @tianji/cli test -- src/__tests__/main-daemon.test.ts src/__tests__/daemon-e2e.test.ts`
Expected: PASS

- [ ] **Step 6: 提交 daemon 模块化与 i18n 文案替换**

```bash
git add apps/cli/src/commands/daemon.ts apps/cli/src/log-follow.ts apps/cli/src/daemon-entry.ts apps/cli/src/__tests__/main-daemon.test.ts apps/cli/src/__tests__/daemon-e2e.test.ts
git commit -m "feat(cli): localize daemon and log command output"
```

### Task 7: 命令调度、locale 切换与命令行为回归 e2e 测试

**Files:**
- Create: `apps/cli/src/__tests__/commands-e2e.test.ts`
- Modify: `apps/cli/src/__tests__/helpers/cli-test-utils.ts`

- [x] **Step 1: 在 `cli-test-utils.ts` 中补充 locale 注入工厂**

```ts
import type { CliDependencies } from '../../commands/types.js'
import type { SupportedLocale, TianjiConfig } from '@tianji/shared'

/**
 * 创建带 locale 注入的 CliDependencies，e2e 测试通过 loadConfig 注入 locale，
 * 不依赖文件系统或环境变量，测试的是 detectLocale → createI18n → 命令输出全链路。
 */
export function createDepsWithLocale(
  locale: SupportedLocale,
  overrides?: Partial<CliDependencies>
): CliDependencies {
  const ctx = createFakeContext()
  return {
    getUserConfigPaths: () => ctx.paths,
    loadConfig: async () => ({ locale }),
    ...overrides,
  }
}

export function createDepsWithoutLocale(
  overrides?: Partial<CliDependencies>
): CliDependencies {
  const ctx = createFakeContext()
  return {
    getUserConfigPaths: () => ctx.paths,
    loadConfig: async () => ({}),
    ...overrides,
  }
}
```

- [x] **Step 2: 写命令调度 e2e 测试——只覆盖全局 help、version、命令级 help、错误路径，不重复断言 run/log/daemon 的业务链路**

```ts
import { describe, it, expect, vi } from 'vitest'
import { runCli } from '../../main.js'
import { captureStdout, createDepsWithLocale, createDepsWithoutLocale } from './helpers/cli-test-utils.js'

describe('command dispatch e2e', () => {
  const deps = createDepsWithoutLocale()

  it('tianji --help lists all commands and global flags', async () => {
    const { exitCode, stdout } = await runCommand(['--help'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('tianji run <prompt>')
    expect(stdout).toContain('tianji daemon <subcommand>')
    expect(stdout).toContain('tianji log')
    expect(stdout).toContain('tianji chat')
    expect(stdout).toContain('-h, --help')
    expect(stdout).toContain('-V, --version')
  })

  it('tianji help is equivalent to --help', async () => {
    const { exitCode, stdout } = await runCommand(['help'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Usage:')
  })

  it('tianji -V outputs version', async () => {
    const { exitCode, stdout } = await runCommand(['-V'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/tianji v\d+\.\d+\.\d+/)
  })

  it('tianji --version outputs version', async () => {
    const { exitCode, stdout } = await runCommand(['--version'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/tianji v\d+\.\d+\.\d+/)
  })

  it('tianji run --help shows run-specific help', async () => {
    const { exitCode, stdout } = await runCommand(['run', '--help'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('<prompt>')
    expect(stdout).not.toContain('tianji daemon')
  })

  it('tianji daemon --help shows subcommand list', async () => {
    const { exitCode, stdout } = await runCommand(['daemon', '--help'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('start')
    expect(stdout).toContain('stop')
    expect(stdout).toContain('restart')
    expect(stdout).toContain('--fg')
  })

  it('tianji log --help shows --follow and --lines', async () => {
    const { exitCode, stdout } = await runCommand(['log', '--help'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('--follow')
    expect(stdout).toContain('--lines')
  })

  it('tianji help daemon is equivalent to daemon --help', async () => {
    const { exitCode, stdout } = await runCommand(['help', 'daemon'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('start')
    expect(stdout).toContain('stop')
  })

  it('no args exits 2 with concise error (no full help dump)', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli([], deps)
    expect(exitCode).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/Missing command/))
    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringMatching(/tianji run <prompt>/))
    stderrSpy.mockRestore()
  })

  it('unknown command exits 2 with error', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli(['wat'], deps)
    expect(exitCode).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/Unknown command "wat"/))
    stderrSpy.mockRestore()
  })

  it('daemon without subcommand exits 2', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli(['daemon'], deps)
    expect(exitCode).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/Missing subcommand/))
    stderrSpy.mockRestore()
  })

  it('daemon with unknown subcommand exits 2', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli(['daemon', 'fly'], deps)
    expect(exitCode).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/Unknown subcommand "fly"/))
    stderrSpy.mockRestore()
  })

  it('run without prompt exits 2', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli(['run'], deps)
    expect(exitCode).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/Missing required argument/))
    stderrSpy.mockRestore()
  })
})
```

- [x] **Step 3: 写 locale 切换 e2e 测试——验证全链路 i18n 输出**

```ts
describe('locale-aware output e2e', () => {
  it('locale=zh-CN renders help in chinese', async () => {
    const { exitCode, stdout } = await runCommand(['--help'], createDepsWithLocale('zh-CN'))
    expect(exitCode).toBe(0)
    expect(stdout).toContain('用法:')
    expect(stdout).toContain('全局选项:')
    expect(stdout).not.toContain('Usage:')
    expect(stdout).not.toContain('Global flags:')
  })

  it('locale=en renders help in english', async () => {
    const { exitCode, stdout } = await runCommand(['--help'], createDepsWithLocale('en'))
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Usage:')
    expect(stdout).toContain('Global flags:')
  })

  it('locale=zh-CN error messages are in chinese', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli(['wat'], createDepsWithLocale('zh-CN'))
    expect(exitCode).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('未知命令'))
    stderrSpy.mockRestore()
  })

  it('locale=zh-CN command-level help is in chinese', async () => {
    const { exitCode, stdout } = await runCommand(['daemon', '--help'], createDepsWithLocale('zh-CN'))
    expect(exitCode).toBe(0)
    expect(stdout).toContain('子命令:')
    expect(stdout).toContain('启动后台守护进程')
  })

  it('no locale configured falls back to en', async () => {
    const { exitCode, stdout } = await runCommand(['--help'], createDepsWithoutLocale())
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Usage:')
  })
})
```

- [x] **Step 4: 写命令行为回归测试——仅补顶层调度侧的最小回归，不重复已有 `run-e2e` / `daemon-e2e` 业务断言**

```ts
describe('command behavior regression', () => {
  it('log --lines 20 passes correct options to followCliLog', async () => {
    const spy = vi.fn(async () => undefined)
    const deps = createDepsWithoutLocale({ followCliLog: spy })
    await runCommand(['log', '--lines', '20'], deps)
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ locale: expect.any(String) }), // i18n
      expect.objectContaining({ lines: 20 })
    )
  })

  it('log defaults to lines=100', async () => {
    const spy = vi.fn(async () => undefined)
    const deps = createDepsWithoutLocale({ followCliLog: spy })
    await runCommand(['log'], deps)
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ lines: 100 })
    )
  })

  it('version output is consistent between -V and --version', async () => {
    const deps = createDepsWithoutLocale()
    const { stdout: short } = await runCommand(['-V'], deps)
    const { stdout: long } = await runCommand(['--version'], deps)
    expect(short).toBe(long)
  })
})
```

- [x] **Step 5: 运行 commands-e2e 测试，确认全部通过**

Run: `pnpm --filter @tianji/cli test -- src/__tests__/commands-e2e.test.ts`
Expected: PASS

- [ ] **Step 6: 提交 e2e 测试与 test utils 扩展**

```bash
git add apps/cli/src/__tests__/commands-e2e.test.ts apps/cli/src/__tests__/helpers/cli-test-utils.ts
git commit -m "test(cli): add command dispatch locale and regression e2e tests"
```

### Task 8: 增加翻译完整性和命令注册一致性测试，补齐构建配置

**Files:**
- Create: `apps/cli/src/__tests__/i18n-completeness.test.ts`
- Modify: `apps/cli/tsconfig.build.json`
- Modify: `apps/cli/package.json`

- [ ] **Step 1: 写失败测试，校验 `zh-CN` key 完整性和命令 description key 可达**

```ts
import enMessages from '../i18n/locales/en.json' with { type: 'json' }
import zhCNMessages from '../i18n/locales/zh-CN.json' with { type: 'json' }

test('zh-CN covers all english message keys', () => {
  const missingKeys = Object.keys(enMessages).filter((key) => !(key in zhCNMessages))
  expect(missingKeys).toEqual([])
})

test('command registry only references existing description keys', () => {
  const visit = (command: CommandDefinition): void => {
    expect(command.description in enMessages).toBe(true)
    command.args?.forEach((arg) => expect(arg.description in enMessages).toBe(true))
    command.options?.forEach((option) => expect(option.description in enMessages).toBe(true))
    command.subcommands?.forEach(visit)
  }

  COMMAND_REGISTRY.forEach(visit)
})
```

- [ ] **Step 2: 运行完整性测试，确认在测试文件创建前失败**

Run: `pnpm --filter @tianji/cli test -- src/__tests__/i18n-completeness.test.ts`
Expected: FAIL

- [ ] **Step 3: 添加完整性测试并修正 `tsconfig.build.json` 对 JSON module 的构建支持**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "noEmit": false,
    "paths": {},
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: 确认 `--version` 的实际读取来源，优先复用仓库已有版本读取模式，只有在现有模式缺失时才回退到 `package.json.version`**

```ts
const VERSION = packageJson.version
```

- [ ] **Step 5: 重跑完整性测试并执行 CLI build，确认 JSON locale 文件参与构建**

Run: `pnpm --filter @tianji/cli test -- src/__tests__/i18n-completeness.test.ts`
Expected: PASS

Run: `pnpm --filter @tianji/cli build`
Expected: PASS，`dist/` 中包含使用 JSON module 的编译产物且无类型错误

- [ ] **Step 6: 提交完整性测试与构建配置**

```bash
git add apps/cli/src/__tests__/i18n-completeness.test.ts apps/cli/tsconfig.build.json apps/cli/package.json
git commit -m "test(cli): validate locale catalogs and command message keys"
```

### Task 9: 更新 README 和架构文档，再执行完整验证

**Files:**
- Modify: `apps/cli/README.md`
- Modify: `docs/CONFIG_DESIGN.md`
- Modify: `docs/ARCHITECTURE_V2.md`

- [ ] **Step 1: 先写下需要同步到 README 的最小内容清单，避免实现后遗漏**

```md
- 删除已废弃的顶层 `status` / `stop` 命令说明
- 把 `tianji help` 扩展为 `tianji help` / `tianji --help` / `tianji <command> --help`
- 把 `tianji log -f` 改为 `tianji log [--follow] [--lines <n>]`
- 新增 `locale` 配置示例
- 更新错误处理表中的帮助与版本行为
```

- [ ] **Step 2: 更新 `apps/cli/README.md`，反映新命令语义与 locale 配置**

```md
`@tianji/cli` 是 `tianji-ai` 的命令行入口，提供 `run`、`log`、`daemon`、`chat` 和 `help` 能力，并支持全局 `-h` / `--help` 与 `-V` / `--version`。

```bash
pnpm tianji --help
pnpm tianji run "hello"
pnpm tianji log --lines 20
pnpm tianji daemon --help
```

```json
{
  "locale": "zh-CN"
}
```
```

- [ ] **Step 3: 按 spec §11 增量更新 `docs/CONFIG_DESIGN.md` 和 `docs/ARCHITECTURE_V2.md`，补前向引用与日期**

```md
> 更新：2026-04-02，补充 CLI locale 配置与命令/i18n 架构。设计依据：[`./superpowers/specs/2026-04-02-cli-i18n-design.md`](./superpowers/specs/2026-04-02-cli-i18n-design.md)
```

- [x] **Step 4: 运行 CLI 全量测试和仓库级检查，修完所有输出后再结束**

Run: `pnpm --filter @tianji/cli test`
Expected: PASS

Run: `pnpm check`
Expected: PASS，且无 error、warning、info 残留需要修复

- [x] **Step 5: 如 `pnpm check` 或全量测试失败，逐项修复并回到对应任务补充最小改动，直到全部通过**

```text
不要跳过失败，不要带着 warning 结束，不要把修复留给“后续任务”。
```

- [ ] **Step 6: 提交文档和最终回归修复**

```bash
git add apps/cli/README.md docs/CONFIG_DESIGN.md docs/ARCHITECTURE_V2.md
git commit -m "docs(cli): document declarative commands and locale support"
```

### Task 10: 最终回归矩阵与验收记录

**Files:**
- Modify: `docs/superpowers/plans/2026-04-02-cli-i18n-implementation-plan.md`

- [x] **Step 1: 执行命令级回归，记录关键场景结果（含 zh-CN 验证）**

Run: `pnpm tianji --help`
Expected: 输出英文全局帮助，包含 `Usage:`、所有命令和 global flags

Run: `pnpm tianji run --help`
Expected: 输出 `run` 命令帮助，包含 `<prompt>` 参数说明

Run: `pnpm tianji --version`
Expected: 输出 `tianji v0.0.1`

Run: `pnpm tianji log --help`
Expected: 输出 `log` 命令帮助，包含 `--follow`、`--lines`

Run: `pnpm tianji daemon --help`
Expected: 输出 daemon 子命令列表（start/status/stop/restart）

Run: `LANG=zh_CN.UTF-8 pnpm tianji --help`
Expected: 输出中文全局帮助，包含 `用法:`、`全局选项:`

Run: `LANG=zh_CN.UTF-8 pnpm tianji daemon --help`
Expected: 输出中文 daemon 帮助，包含 `子命令:`

Run: `pnpm tianji wat`
Expected: exit 2，输出 `Unknown command "wat"` + help hint（不含完整帮助文本）

- [x] **Step 2: 在本计划底部追加实际执行结果，作为 handoff 记录**

```md
## Execution Notes

- `pnpm --filter @tianji/cli test`: PASS
- `pnpm check`: PASS
- `pnpm tianji --help`: PASS
- `pnpm tianji run --help`: PASS
- `pnpm tianji --version`: PASS
- `pnpm tianji daemon --help`: PASS
- `LANG=zh_CN.UTF-8 pnpm tianji --help`: PASS (中文输出)
- `LANG=zh_CN.UTF-8 pnpm tianji daemon --help`: PASS (中文输出)
- `pnpm tianji wat`: PASS (exit 2, concise error)
```

- [ ] **Step 3: 最终提交验收记录**

```bash
git add docs/superpowers/plans/2026-04-02-cli-i18n-implementation-plan.md
git commit -m "docs(plan): record cli i18n implementation verification"
```

---

## Self-Review

- Spec coverage:
  - §4 命令架构目标对应 Task 3-6。
  - §5 i18n 设计对应 Task 2、Task 8。
  - §6 config schema 扩展对应 Task 1。
  - §8 测试策略对应 Task 2-8，**新增 Task 7 专门覆盖 e2e 测试（命令调度、locale 切换、行为回归）**。
  - §11 文档更新对应 Task 9。
  - Task 10 用于记录最终验收与执行结果，包含中文 locale 验证。
- Review 修复记录：
  - `normalizeLocale` 收紧 zh 匹配：改用 `ZH_CN_VARIANTS` 白名单，避免 `zh-TW`/`zh-Hant` 错误映射到 `zh-CN`。
  - `detectLocale` 回到 spec 约束：只保留 `config -> Intl -> en`，不引入环境变量 fallback。
  - `RunCommandDependencies` 改名为 `CliDependencies`，解耦 run 命令特有类型与通用 `CommandContext`。
  - `CliDependencies.followCliLog` 签名预置 `i18n` 参数，与 Task 6 改造对齐。
  - `CliDependencies.loadConfig` 新增，支持 e2e 测试注入 locale 而不依赖文件系统。
  - `extractGlobalFlags` 增强：`--version` 任意位置生效、`tianji help <command>` 映射到命令级帮助。
  - 收口测试职责：`commands-e2e.test.ts` 只覆盖顶层调度/locale/help/error matrix，业务链路分别留在已有 `run-e2e` 和 `daemon-e2e` 中。
  - 去掉 `main.ts` 中对未验证配置读取 API 的硬绑定，要求实现前先复用现有最小入口。
  - Task 10 手工回归补充 `LANG=zh_CN.UTF-8` 场景和错误路径验证。
- Placeholder scan:
  - 未保留 `TODO`、`TBD`、`appropriate error handling` 之类空泛占位语。
  - 每个任务都给出了明确文件、测试、命令或代码骨架。
- Type consistency:
  - 统一使用 `CommandDefinition`、`CommandContext`、`I18n`、`SupportedLocale`、`COMMAND_REGISTRY`、`CliDependencies` 命名。
  - `log` 默认值固定为 `follow: true`、`lines: 100`，与 spec 一致。
- 已知边界（本次不做）：
  - 不支持 `--lang`/`--locale` CLI flag 级别的 locale 覆盖。
  - `--follow` flag 暂无 non-follow 模式实现（当前 log 命令只有 follow 模式），flag 保留为未来扩展点。

## Execution Notes

- `pnpm --filter @tianji/cli test`: PASS
- `pnpm --filter @tianji/shared build && pnpm --filter @tianji/cli test && pnpm --filter @tianji/cli build && pnpm check`: PASS
- `pnpm tianji --help`: PASS
- `pnpm tianji run --help`: PASS
- `pnpm tianji --version`: PASS
- `pnpm tianji log --help`: PASS
- `pnpm tianji daemon --help`: PASS
- `LANG=zh_CN.UTF-8 pnpm tianji --help`: PASS（中文输出）
- `LANG=zh_CN.UTF-8 pnpm tianji daemon --help`: PASS（中文输出）
- `pnpm tianji wat`: PASS（CLI 保持 exit 2 与简洁错误；根 `pnpm run` 仍追加一行 `ELIFECYCLE`，已去除先前的 `undefined` 和 `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` 包装噪音）
