# Daemon Register Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 node 的 controlplane 注册入口统一收敛到 `tianji daemon start --register <url>`，删除顶层 `register` 命令，并让 `daemon start` 在已有配置冲突时以交互确认方式决定是否覆盖。

**Architecture:** CLI 层只负责解析 `--register`、加载/比较/保存注册配置并做交互确认；daemon 启动链路统一从用户配置读取 controlplane 注册信息。`daemon start` 负责首次注册与配置覆盖，`daemon restart` 只复用已保存配置，不承担配置变更职责。拒绝覆盖视为用户主动取消，直接返回退出码 `0`。

**Tech Stack:** TypeScript, Node.js CLI, Vitest, pnpm, existing `@tianji/agent` user config paths

---

## File Map

- Modify: `apps/node/src/commands/daemon.ts`
  - 为 `daemon start` 增加 `--register <url>` 选项
  - 在 start 流程中接入注册配置读取、比较、覆盖确认与保存
  - 保持 `restart` 只支持 `--fg`
- Modify: `apps/node/src/main.ts`
  - 删除顶层 `RegisterCommand` stage-2 解析分支
  - 更新 `DaemonCommand` 结构，补充 `registerUrl` 字段
- Modify: `apps/node/src/commands/registry.ts`
  - 从命令注册表移除顶层 `register` 命令
- Modify or split: `apps/node/src/commands/register.ts`
  - 保留 `parseRegisterUrl()` 解析工具
  - 删除顶层命令 handler，或将解析工具迁移为纯工具模块
- Create: `apps/node/src/node-runtime/controlplane-config.ts`
  - 封装 controlplane 注册配置的读写、比较、构造 runtime config 的逻辑
- Modify: `apps/node/src/daemon-entry.ts`
  - 从用户配置加载 controlplane 注册信息
  - 若缺失配置则在 daemon 启动早期失败，并输出明确错误
- Modify: `apps/node/src/commands/types.ts`
  - 为 CLI 依赖增加可注入的确认函数与配置读写依赖，便于测试
- Test: `apps/node/src/__tests__/main-daemon.test.ts`
  - 覆盖 `daemon start --register`
  - 覆盖 `daemon restart --register` 非法
  - 删除顶层 `register` 解析测试
- Test: `apps/node/src/__tests__/daemon-e2e.test.ts`
  - 覆盖无配置时报错
  - 覆盖首次注册成功
  - 覆盖已有不同配置时默认不覆盖并返回 `0`
  - 覆盖已有不同配置时确认覆盖后启动
  - 覆盖同配置不提示
- Test: `apps/node/src/__tests__/register-command.test.ts`
  - 缩减为纯 `parseRegisterUrl()` 单测，或迁移到新的 config test 文件
- Modify: `apps/node/src/__tests__/helpers/cli-test-utils.ts`
  - 增加注入确认输入/确认函数的测试辅助
- Modify: `README.md` and any package-level README touching CLI usage
  - 更新命令示例与首次启动说明

### Task 1: 建立 controlplane 注册配置存储模型

**Files:**
- Create: `apps/node/src/node-runtime/controlplane-config.ts`
- Modify: `apps/node/src/commands/register.ts`
- Test: `apps/node/src/__tests__/register-command.test.ts`

- [ ] **Step 1: 写失败测试，定义注册 URL 解析与配置比较行为**

```ts
import { describe, expect, it } from 'vitest'

import {
  areStoredRegisterConfigsEqual,
  parseRegisterUrl,
} from '../commands/register.js'

describe('parseRegisterUrl', () => {
  it('extracts baseUrl and enrollment token', () => {
    expect(parseRegisterUrl('http://127.0.0.1:3000/register?enrollment-token=test-token')).toEqual({
      baseUrl: 'http://127.0.0.1:3000',
      enrollmentToken: 'test-token',
    })
  })
})

describe('areStoredRegisterConfigsEqual', () => {
  it('compares parsed register configs by baseUrl and enrollmentToken', () => {
    expect(
      areStoredRegisterConfigsEqual(
        { baseUrl: 'http://127.0.0.1:3000', enrollmentToken: 'aaa' },
        { baseUrl: 'http://127.0.0.1:3000', enrollmentToken: 'bbb' }
      )
    ).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @tianji/node test register-command.test.ts`
Expected: FAIL，提示 `areStoredRegisterConfigsEqual` 或新配置工具尚未定义

- [ ] **Step 3: 实现最小配置模型与比较工具**

```ts
import { hostname, platform } from 'node:os'

import { createNodeId, type NodeId } from '@tianji/shared'

import type { TianjiConfig } from '@tianji/shared'

export interface StoredControlPlaneConfig {
  readonly baseUrl: string
  readonly enrollmentToken: string
  readonly nodeId: NodeId
  readonly hostname: string
  readonly platform: string
  readonly version: string
}

export function buildStoredControlPlaneConfig(input: {
  baseUrl: string
  enrollmentToken: string
}): StoredControlPlaneConfig {
  return {
    baseUrl: input.baseUrl,
    enrollmentToken: input.enrollmentToken,
    nodeId: createNodeId(process.env.TIANJI_NODE_ID ?? hostname()),
    hostname: process.env.TIANJI_NODE_HOSTNAME ?? hostname(),
    platform: process.env.TIANJI_NODE_PLATFORM ?? platform(),
    version: process.env.TIANJI_NODE_VERSION ?? '0.0.1',
  }
}

export function areStoredControlPlaneConfigsEqual(
  left: Pick<StoredControlPlaneConfig, 'baseUrl' | 'enrollmentToken'>,
  right: Pick<StoredControlPlaneConfig, 'baseUrl' | 'enrollmentToken'>
): boolean {
  return left.baseUrl === right.baseUrl && left.enrollmentToken === right.enrollmentToken
}

export function readStoredControlPlaneConfig(
  config: Partial<TianjiConfig>
): StoredControlPlaneConfig | null {
  const controlPlane = config.controlPlane
  if (!controlPlane?.baseUrl || !controlPlane.enrollmentToken || !controlPlane.nodeId) {
    return null
  }

  return {
    baseUrl: controlPlane.baseUrl,
    enrollmentToken: controlPlane.enrollmentToken,
    nodeId: controlPlane.nodeId,
    hostname: controlPlane.hostname ?? hostname(),
    platform: controlPlane.platform ?? platform(),
    version: controlPlane.version ?? '0.0.1',
  }
}
```

- [ ] **Step 4: 再跑测试确认通过**

Run: `pnpm --filter @tianji/node test register-command.test.ts`
Expected: PASS

- [ ] **Step 5: 提交本任务**

```bash
git add apps/node/src/node-runtime/controlplane-config.ts apps/node/src/commands/register.ts apps/node/src/__tests__/register-command.test.ts
git commit -m "refactor(node): extract controlplane register config helpers"
```

### Task 2: 为 daemon start 接入 --register 解析

**Files:**
- Modify: `apps/node/src/commands/daemon.ts`
- Modify: `apps/node/src/main.ts`
- Modify: `apps/node/src/commands/registry.ts`
- Modify: `apps/node/src/__tests__/main-daemon.test.ts`

- [ ] **Step 1: 写失败测试，定义 CLI 解析结果**

```ts
it('parses daemon start register flag', () => {
  expect(
    parseCliArgs([
      'daemon',
      'start',
      '--register',
      'http://127.0.0.1:3000/register?enrollment-token=test-token',
    ])
  ).toEqual({
    kind: 'daemon',
    subcommand: 'start',
    foreground: false,
    registerUrl: 'http://127.0.0.1:3000/register?enrollment-token=test-token',
  })
})

it('rejects daemon restart register flag', () => {
  expect(() =>
    parseCliArgs([
      'daemon',
      'restart',
      '--register',
      'http://127.0.0.1:3000/register?enrollment-token=test-token',
    ])
  ).toThrow(/Unknown option "--register"/)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @tianji/node test main-daemon.test.ts`
Expected: FAIL，`registerUrl` 字段尚未出现在 `parseCliArgs()` 结果中

- [ ] **Step 3: 实现 CLI 解析最小改动**

```ts
export interface DaemonCommand {
  readonly kind: 'daemon'
  readonly subcommand: DaemonSubcommand
  readonly foreground: boolean
  readonly registerUrl?: string
}

const daemonStartCommand: CommandDefinition = {
  name: 'start',
  description: 'cmd.daemon.start.description',
  options: [
    { long: '--fg', description: 'cmd.daemon.start.option.fg', type: 'boolean' },
    { long: '--register', description: 'cmd.daemon.start.option.register', type: 'string' },
  ],
  // ...
}

if (parsed.command.name === 'register') {
  throw new CliUsageError('Unknown command "register". Use "tianji daemon start --register <url>" instead.')
}

const foreground = parsed.context.options.fg === true
const registerUrl = parsed.context.options.register as string | undefined
```

- [ ] **Step 4: 再跑测试确认通过**

Run: `pnpm --filter @tianji/node test main-daemon.test.ts`
Expected: PASS

- [ ] **Step 5: 提交本任务**

```bash
git add apps/node/src/commands/daemon.ts apps/node/src/main.ts apps/node/src/commands/registry.ts apps/node/src/__tests__/main-daemon.test.ts
git commit -m "refactor(node): move register entry into daemon start"
```

### Task 3: 为 daemon start 接入配置加载、冲突确认与退出码语义

**Files:**
- Modify: `apps/node/src/commands/daemon.ts`
- Modify: `apps/node/src/commands/types.ts`
- Modify: `apps/node/src/__tests__/helpers/cli-test-utils.ts`
- Test: `apps/node/src/__tests__/main-daemon.test.ts`
- Test: `apps/node/src/__tests__/daemon-e2e.test.ts`

- [ ] **Step 1: 写失败测试，定义无配置、拒绝覆盖、确认覆盖三类行为**

```ts
it('returns non-zero when daemon start has no stored register config and no --register', async () => {
  const { paths, cleanup } = await createTempCliPaths()
  try {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli(['daemon', 'start', '--fg'], {
      getUserConfigPaths: () => paths,
      loadConfig: async () => ({}),
    })
    expect(exitCode).toBe(1)
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/Use "tianji daemon start --register/))
    stderr.mockRestore()
  } finally {
    await cleanup()
  }
})

it('returns 0 without starting when overwrite is declined', async () => {
  const confirmOverwrite = vi.fn(async () => false)
  const runDaemonEntry = vi.fn(async () => undefined)

  const exitCode = await runCli(['daemon', 'start', '--fg', '--register', 'http://127.0.0.1:3000/register?enrollment-token=new'], {
    loadConfig: async () => ({
      controlPlane: {
        baseUrl: 'http://127.0.0.1:3000',
        enrollmentToken: 'old',
        nodeId: 'node-1',
      },
    }),
    confirmOverwrite,
    runDaemonEntry,
  })

  expect(exitCode).toBe(0)
  expect(confirmOverwrite).toHaveBeenCalledOnce()
  expect(runDaemonEntry).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @tianji/node test main-daemon.test.ts daemon-e2e.test.ts`
Expected: FAIL，缺少配置加载和覆盖确认流程

- [ ] **Step 3: 实现 start 子命令的配置决策流程**

```ts
export interface CliDependencies {
  readonly confirmOverwrite?: (message: string) => Promise<boolean>
  readonly saveConfig?: (config: Partial<TianjiConfig>) => Promise<void>
}

async function resolveControlPlaneStartConfig(context: CommandContext): Promise<StoredControlPlaneConfig | null> {
  const loadedConfig = (await context.deps?.loadConfig?.().catch(() => ({}))) ?? {}
  const stored = readStoredControlPlaneConfig(loadedConfig)
  const registerUrl = context.options.register as string | undefined

  if (!registerUrl) {
    return stored
  }

  const parsed = parseRegisterUrl(registerUrl)
  const candidate = buildStoredControlPlaneConfig(parsed)

  if (stored === null) {
    await persistControlPlaneConfig(candidate, context)
    return candidate
  }

  if (areStoredControlPlaneConfigsEqual(stored, candidate)) {
    return stored
  }

  const confirmed = await confirmControlPlaneOverwrite(stored, candidate, context)
  if (!confirmed) {
    return null
  }

  await persistControlPlaneConfig(candidate, context)
  return candidate
}
```

- [ ] **Step 4: 再跑测试确认通过**

Run: `pnpm --filter @tianji/node test main-daemon.test.ts daemon-e2e.test.ts`
Expected: PASS

- [ ] **Step 5: 提交本任务**

```bash
git add apps/node/src/commands/daemon.ts apps/node/src/commands/types.ts apps/node/src/__tests__/helpers/cli-test-utils.ts apps/node/src/__tests__/main-daemon.test.ts apps/node/src/__tests__/daemon-e2e.test.ts
git commit -m "feat(node): add daemon start register confirmation flow"
```

### Task 4: 将 daemon 启动链路切到持久化 controlplane 配置

**Files:**
- Modify: `apps/node/src/daemon-entry.ts`
- Modify: `apps/node/src/node-runtime/controlplane-runtime.ts`
- Modify: `apps/node/src/node-runtime/env-config.ts`
- Test: `apps/node/src/node-runtime/__tests__/env-config.test.ts`
- Test: `apps/node/src/__tests__/daemon-e2e.test.ts`

- [ ] **Step 1: 写失败测试，定义 daemon 启动依赖用户配置中的 controlplane 配置**

```ts
it('returns null when user config has no stored controlplane config', () => {
  expect(readStoredControlPlaneConfig({})).toBeNull()
})

it('builds runtime config from stored controlplane config', () => {
  expect(
    createRuntimeConfigFromStoredControlPlane({
      baseUrl: 'http://127.0.0.1:3000',
      enrollmentToken: 'token',
      nodeId: 'node-1',
      hostname: 'host',
      platform: 'linux',
      version: '0.0.1',
    }).baseUrl
  ).toBe('http://127.0.0.1:3000')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @tianji/node test env-config.test.ts daemon-e2e.test.ts`
Expected: FAIL，daemon 启动链路尚未使用持久化注册配置

- [ ] **Step 3: 实现 daemon-entry 对持久化配置的加载**

```ts
export async function runDaemonEntry(): Promise<void> {
  const context = await loadUserConfigContext()
  const i18n = createI18n(detectLocale(context.config))
  const controlPlaneConfig = readStoredControlPlaneConfig(context.config)

  if (controlPlaneConfig === null) {
    throw new Error('No register URL configured. Use "tianji daemon start --register <url>" first.')
  }

  const runtime = createControlPlaneRuntime({
    ...controlPlaneConfig,
    agentList: [],
  })

  await runtime.connection.start()
  // keep runtime alive alongside daemon server startup
}
```

- [ ] **Step 4: 再跑测试确认通过**

Run: `pnpm --filter @tianji/node test env-config.test.ts daemon-e2e.test.ts`
Expected: PASS

- [ ] **Step 5: 提交本任务**

```bash
git add apps/node/src/daemon-entry.ts apps/node/src/node-runtime/controlplane-runtime.ts apps/node/src/node-runtime/env-config.ts apps/node/src/node-runtime/__tests__/env-config.test.ts apps/node/src/__tests__/daemon-e2e.test.ts
git commit -m "feat(node): load daemon controlplane runtime from stored config"
```

### Task 5: 更新帮助文案与 README，并完成整体验证

**Files:**
- Modify: `README.md`
- Modify: any affected package README under `apps/node/`
- Modify: CLI help snapshots/tests if present

- [ ] **Step 1: 写失败测试或断言，定义帮助文案变化**

```ts
it('shows daemon start register option in help', async () => {
  const output = await captureStdout(async () => {
    const exitCode = await runCli(['daemon', '--help'])
    expect(exitCode).toBe(0)
  })

  expect(output).toContain('--register')
  expect(output).not.toContain('tianji register')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @tianji/node test main-daemon.test.ts commands-help.test.ts`
Expected: FAIL，help 文案尚未更新

- [ ] **Step 3: 更新 README 和帮助文案**

```md
## Start daemon with controlplane registration

```bash
tianji daemon start --register "http://127.0.0.1:3000/register?enrollment-token=..."
```

首次启动必须提供 `--register`。后续 `tianji daemon start` 与 `tianji daemon restart` 会复用已保存配置。

如果再次传入新的注册 URL，CLI 会提示是否覆盖，默认不覆盖并直接退出。
```

- [ ] **Step 4: 运行回归测试与检查**

Run: `pnpm --filter @tianji/node test`
Expected: PASS

Run: `pnpm check`
Expected: PASS，无 errors、warnings、infos

- [ ] **Step 5: 提交本任务**

```bash
git add README.md apps/node/src/__tests__/main-daemon.test.ts apps/node/src/__tests__/commands-help.test.ts
git commit -m "docs(node): document daemon register startup flow"
```

## Self-Review

- Spec coverage: 已覆盖命令收敛、`start --register`、覆盖确认、`restart` 不允许更新配置、拒绝覆盖返回 `0`、README/help、`pnpm check` 验证。
- Placeholder scan: 计划中的新增模块、命令、测试文件和验证命令都已明确，无 TODO/TBD。
- Type consistency: 统一使用 `registerUrl`、`StoredControlPlaneConfig`、`controlPlane` 配置字段，避免同义命名漂移。
