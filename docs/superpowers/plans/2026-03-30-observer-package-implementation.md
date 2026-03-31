# Observer Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `@tianji/observer` workspace package，完成 logger + tracing 的稳定边界，并在第一阶段把 CLI 日志实现迁移到该包且保持 JSONL 文件格式、日志路径与 `tianji log -f` 行为兼容。

**Architecture:** 方案以领域化 `ObserverLogger` 和 tracing 生命周期 API 为公共边界，内部通过多 sink 适配 JSONL 文件、stdout 与测试场景。第一阶段只迁移 CLI logger，runtime 仅补 observer 接入边界类型，不引入大规模新日志或 tracing 埋点，避免跨执行链路扩散。

**Tech Stack:** TypeScript、pnpm workspace、Vitest、Biome、OpenTelemetry SDK

---

## 文件结构与职责

### 新增 package

- `packages/observer/package.json`：声明 `@tianji/observer` 包名、导出、依赖和脚本。
- `packages/observer/tsconfig.build.json`：observer 构建配置，和现有 package 保持一致。
- `packages/observer/README.md`：说明 logger API、sink、tracing 初始化方式和 CLI 兼容边界。
- `packages/observer/src/index.ts`：统一导出 logger、tracing 和稳定类型。
- `packages/observer/src/types.ts`：仓库级 observer 稳定类型出口。

### logger 层

- `packages/observer/src/logger/types.ts`：`ObserverLogLevel`、`ObserverLogEntry`、`ObserverLogger`、`ObserverLogSink` 等定义。
- `packages/observer/src/logger/logger.ts`：`createObserverLogger()`、`child()`、entry 构建、bindings 合并、sink 分发。
- `packages/observer/src/logger/sanitize.ts`：递归脱敏、`Error` 归一化、空对象裁剪。
- `packages/observer/src/logger/index.ts`：logger 层公共导出。
- `packages/observer/src/logger/sinks/file-jsonl.ts`：JSONL 文件 sink，兼容 CLI 当前日志文件格式。
- `packages/observer/src/logger/sinks/stdout.ts`：stdout sink，支持结构化 JSON 输出与可选 pretty 行输出。
- `packages/observer/src/logger/sinks/memory.ts`：内存 sink，供单元测试断言。
- `packages/observer/src/logger/__tests__/logger.test.ts`：覆盖 JSONL sink、脱敏、child logger、memory sink。

### tracing 层

- `packages/observer/src/tracing/types.ts`：`ObserverTracingConfig`、exporter 类型和 helper 入参类型。
- `packages/observer/src/tracing/state.ts`：全局 tracing 状态、provider/tracer 生命周期引用。
- `packages/observer/src/tracing/tracer.ts`：`initTracing()`、`shutdownTracing()`、`isTracingEnabled()`、`getTracer()`。
- `packages/observer/src/tracing/spans.ts`：`startSessionSpan()`、`startRunSpan()`、`startToolSpan()`、`startLlmCallSpan()`。
- `packages/observer/src/tracing/index.ts`：tracing 公共导出。
- `packages/observer/src/tracing/__tests__/tracing.test.ts`：disabled 行为和 init/shutdown 生命周期测试。

### 集成修改

- `apps/cli/package.json`：添加 `@tianji/observer` 依赖。
- `apps/cli/src/logger.ts`：改为薄适配层或删除本地实现，统一转向 observer。
- `apps/cli/src/log-follow.ts`：改用 `@tianji/observer` 导出的日志类型和 level/scope 校验。
- `apps/cli/src/main.ts`：CLI logger 创建逻辑切换到 observer JSONL sink。
- `apps/cli/src/__tests__/run-e2e.test.ts`：补强 CLI 日志回归断言，确认 observer 迁移后行为不变。
- `packages/runtime/src/runtime.ts`：为后续阶段预留 `logger?: ObserverLogger` 入口类型。
- `packages/runtime/README.md`：更新 runtime 将预留 observer logger 接入边界的说明。
- `README.md`：仓库结构与核心包说明加入 `packages/observer`。
- `apps/cli/README.md`：日志实现描述改为由 observer 包统一提供。

## 实施约束

- 全程遵守设计文档 `docs/superpowers/specs/2026-03-30-observer-package-design.md`，不得把 runtime tracing 扩展成大范围埋点改造。
- 不暴露 `pino.Logger` 给业务层；如果 stdout sink 选择 `pino`，它只能留在 observer 内部。
- 不能改动 JSONL 顶层字段结构，`apps/cli/src/log-follow.ts` 的兼容行为必须保留。
- tracing 初始化必须由应用入口显式调用，不能在 runtime 内部自动启动。
- 若发生代码变更，结束前必须在仓库根目录执行 `pnpm check` 并修复全部问题。
- 本计划不要求运行测试；若执行阶段补充或修改测试，测试只能在对应 package 根目录运行。

### Task 1: 建立 observer package 骨架与工作区接入

**Files:**
- Create: `packages/observer/package.json`
- Create: `packages/observer/tsconfig.build.json`
- Create: `packages/observer/src/index.ts`
- Create: `packages/observer/src/types.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Test: `packages/observer/package.json`

- [ ] **Step 1: 写工作区接入的失败测试或验证脚本**

```json
{
  "name": "@tianji/observer",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

验证目标：`pnpm --filter @tianji/observer typecheck` 在 package 创建前应失败，报错为过滤目标不存在或入口文件缺失。

- [ ] **Step 2: 运行验证命令确认当前失败**

Run: `pnpm --filter @tianji/observer typecheck`
Expected: FAIL，提示 workspace 中不存在 `@tianji/observer` 或 package 缺少配置。

- [ ] **Step 3: 写最小 package 骨架实现**

```json
{
  "name": "@tianji/observer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.build.json --noEmit",
    "clean": "rimraf dist"
  },
  "dependencies": {},
  "devDependencies": {}
}
```

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/tsconfig.build.tsbuildinfo"
  },
  "include": ["src/**/*.ts"]
}
```

```ts
export {}
```

说明：`pnpm-workspace.yaml` 若已使用 `packages/*` 通配，无需改动；若不是，补上 `packages/observer`。

- [ ] **Step 4: 运行类型检查确认骨架可被 workspace 识别**

Run: `pnpm --filter @tianji/observer typecheck`
Expected: PASS

- [ ] **Step 5: 提交骨架接入**

```bash
git add packages/observer/package.json packages/observer/tsconfig.build.json packages/observer/src/index.ts packages/observer/src/types.ts pnpm-workspace.yaml package.json
git commit -m "$(cat <<'EOF'
feat(observer): 建立 observer 包基础骨架

为什么需要这个改动：
当前仓库还没有 `@tianji/observer` workspace package，后续 logger 与 tracing 实现缺少稳定落点。
先建立包骨架，可以让后续类型、sink 和 CLI 迁移按统一边界逐步推进。

技术实现：
- 新增 `packages/observer` package 基础目录与构建配置
- 配置包级 `exports`、`main`、`types` 和基础脚本
- 接入 workspace，使 `pnpm --filter @tianji/observer` 可正常工作

解决的问题：
为 observer 功能实现提供独立包边界，避免后续实现分散到 CLI 或 runtime 中。

相关信息：
- 影响范围: workspace 包结构与构建入口
EOF
)"
```

### Task 2: 定义 observer 稳定类型与 logger 公共接口

**Files:**
- Modify: `packages/observer/src/types.ts`
- Create: `packages/observer/src/logger/types.ts`
- Create: `packages/observer/src/logger/index.ts`
- Modify: `packages/observer/src/index.ts`
- Test: `packages/observer/src/logger/__tests__/logger-types.test.ts`

- [ ] **Step 1: 先写类型层测试，锁定公共 API 形状**

```ts
import type {
  ObserverLogEntry,
  ObserverLogLevel,
  ObserverLogScope,
  ObserverLogger,
} from '../../index.js'

const level: ObserverLogLevel = 'info'
const scope: ObserverLogScope = ['cli', 'run']

declare const logger: ObserverLogger

void logger.info(scope, 'message', { ok: true })

const entry: ObserverLogEntry = {
  timestamp: '2026-03-30T00:00:00.000Z',
  level,
  scope,
  message: 'message',
}

void entry
```

- [ ] **Step 2: 运行类型检查确认当前失败**

Run: `pnpm --filter @tianji/observer typecheck`
Expected: FAIL，缺少 `ObserverLogEntry`、`ObserverLogger` 等导出。

- [ ] **Step 3: 写最小稳定类型实现**

```ts
export type ObserverLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export type ObserverLogScope = readonly [string, ...string[]]

export interface ObserverLogEntry {
  readonly timestamp: string
  readonly level: ObserverLogLevel
  readonly scope: ObserverLogScope
  readonly message: string
  readonly data?: Record<string, unknown>
}

export interface ObserverLogSink {
  write(entry: ObserverLogEntry): Promise<void>
}

export interface ObserverLogger {
  log(
    level: ObserverLogLevel,
    scope: ObserverLogScope,
    message: string,
    data?: Record<string, unknown>
  ): Promise<void>
  trace(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  debug(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  info(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  warn(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  error(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  fatal(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  child(options?: {
    scope?: ObserverLogScope
    bindings?: Record<string, unknown>
  }): ObserverLogger
}
```

```ts
export type {
  ObserverLogEntry,
  ObserverLogLevel,
  ObserverLogScope,
  ObserverLogSink,
  ObserverLogger,
} from './logger/types.js'
```

- [ ] **Step 4: 运行类型检查确认公共接口稳定**

Run: `pnpm --filter @tianji/observer typecheck`
Expected: PASS

- [ ] **Step 5: 提交类型层**

```bash
git add packages/observer/src/index.ts packages/observer/src/types.ts packages/observer/src/logger/types.ts packages/observer/src/logger/index.ts packages/observer/src/logger/__tests__/logger-types.test.ts
git commit -m "$(cat <<'EOF'
feat(observer): 定义 logger 公共类型接口

为什么需要这个改动：
CLI、runtime 和后续业务代码需要依赖统一的 observer 边界，而不是直接绑定具体日志实现。
先稳定类型层，才能保证后续 logger、sink 和 tracing 的实现不会反复改公共 API。

技术实现：
- 定义 `ObserverLogLevel`、`ObserverLogScope`、`ObserverLogEntry`
- 定义 `ObserverLogSink` 与 `ObserverLogger` 公共接口
- 在 observer 顶层和 logger 层补齐类型导出

解决的问题：
建立了仓库级稳定日志协议，后续实现可以围绕统一接口推进。

相关信息：
- 影响范围: observer 公共类型导出
EOF
)"
```

### Task 3: 实现 logger 脱敏与核心写入器

**Files:**
- Create: `packages/observer/src/logger/sanitize.ts`
- Create: `packages/observer/src/logger/logger.ts`
- Modify: `packages/observer/src/logger/index.ts`
- Test: `packages/observer/src/logger/__tests__/logger.test.ts`

- [ ] **Step 1: 先写 logger 单元测试，覆盖脱敏、bindings 和 child scope**

```ts
import { describe, expect, it } from 'vitest'

import { createMemorySink, createObserverLogger } from '../index.js'

describe('createObserverLogger', () => {
  it('redacts sensitive keys and normalizes Error values', async () => {
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })

    await logger.info(['cli'], 'loaded', {
      apiKey: 'secret',
      nested: { prompt: 'hidden', keep: true },
      error: new Error('boom'),
    })

    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0]?.data).toEqual({
      nested: { keep: true },
      error: { name: 'Error', message: 'boom' },
    })
  })

  it('merges child scope and bindings', async () => {
    const sink = createMemorySink()
    const logger = createObserverLogger({
      sinks: [sink],
      scope: ['cli'],
      bindings: { agentName: 'default' },
    }).child({ scope: ['run'], bindings: { provider: 'openai' } })

    await logger.info(['event'], 'received', { eventType: 'message.delta' })

    expect(sink.entries[0]).toMatchObject({
      scope: ['cli', 'run', 'event'],
      data: {
        agentName: 'default',
        provider: 'openai',
        eventType: 'message.delta',
      },
    })
  })
})
```

- [ ] **Step 2: 运行 observer 测试确认当前失败**

Run: `pnpm --filter @tianji/observer test -- --run packages/observer/src/logger/__tests__/logger.test.ts`
Expected: FAIL，缺少 `createObserverLogger`、`createMemorySink` 和脱敏实现。

- [ ] **Step 3: 写最小 logger 核心实现**

```ts
const DEFAULT_SENSITIVE_KEYS = ['apiKey', 'prompt', 'soul'] as const

export function sanitizeObserverLogData(
  data: Record<string, unknown> | undefined,
  sensitiveKeys: ReadonlySet<string>
): Record<string, unknown> | undefined {
  if (data === undefined) {
    return undefined
  }

  const entries = Object.entries(data).flatMap(([key, value]) => {
    if (sensitiveKeys.has(key)) {
      return []
    }

    return [[key, sanitizeObserverLogValue(value, sensitiveKeys)] as const]
  })

  if (entries.length === 0) {
    return undefined
  }

  return Object.fromEntries(entries)
}
```

```ts
export function createObserverLogger(options: {
  sinks: readonly ObserverLogSink[]
  scope?: ObserverLogScope
  bindings?: Record<string, unknown>
  sensitiveKeys?: readonly string[]
}): ObserverLogger {
  const baseScope = options.scope ?? undefined
  const baseBindings = options.bindings ?? undefined
  const sensitiveKeys = new Set([...
    DEFAULT_SENSITIVE_KEYS,
    ...(options.sensitiveKeys ?? []),
  ])

  const write = async (
    level: ObserverLogLevel,
    scope: ObserverLogScope,
    message: string,
    data?: Record<string, unknown>
  ): Promise<void> => {
    const mergedScope = ([...(baseScope ?? []), ...scope] as string[]) as ObserverLogScope
    const mergedData = sanitizeObserverLogData(
      {
        ...(baseBindings ?? {}),
        ...(data ?? {}),
      },
      sensitiveKeys
    )

    const entry: ObserverLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      scope: mergedScope,
      message,
      ...(mergedData === undefined ? {} : { data: mergedData }),
    }

    for (const sink of options.sinks) {
      await sink.write(entry)
    }
  }

  return {
    log: write,
    trace: (scope, message, data) => write('trace', scope, message, data),
    debug: (scope, message, data) => write('debug', scope, message, data),
    info: (scope, message, data) => write('info', scope, message, data),
    warn: (scope, message, data) => write('warn', scope, message, data),
    error: (scope, message, data) => write('error', scope, message, data),
    fatal: (scope, message, data) => write('fatal', scope, message, data),
    child: (childOptions = {}) =>
      createObserverLogger({
        sinks: options.sinks,
        scope: ([...(baseScope ?? []), ...(childOptions.scope ?? [])] as string[]) as ObserverLogScope,
        bindings: {
          ...(baseBindings ?? {}),
          ...(childOptions.bindings ?? {}),
        },
        sensitiveKeys: [...sensitiveKeys],
      }),
  }
}
```

- [ ] **Step 4: 运行 logger 测试确认实现通过**

Run: `pnpm --filter @tianji/observer test -- --run packages/observer/src/logger/__tests__/logger.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 logger 核心实现**

```bash
git add packages/observer/src/logger/sanitize.ts packages/observer/src/logger/logger.ts packages/observer/src/logger/index.ts packages/observer/src/logger/__tests__/logger.test.ts
git commit -m "$(cat <<'EOF'
feat(observer): 实现 logger 核心与脱敏逻辑

为什么需要这个改动：
设计文档要求 observer 统一负责结构化日志 entry 生成、bindings 合并和敏感字段过滤。
如果这些逻辑继续散落在调用方，CLI 迁移后仍然无法形成稳定边界。

技术实现：
- 新增 logger 核心写入器与 `child()` 组合逻辑
- 实现默认敏感字段过滤和递归脱敏
- 将 `Error` 归一化为 `{ name, message }`
- 补充 logger 单元测试覆盖脱敏和 scope/bindings 合并

解决的问题：
observer 现在可以稳定生成兼容设计文档的结构化日志，并统一处理敏感信息。

相关信息：
- 影响范围: observer logger 核心行为
EOF
)"
```

### Task 4: 实现 JSONL file sink、stdout sink、memory sink

**Files:**
- Create: `packages/observer/src/logger/sinks/file-jsonl.ts`
- Create: `packages/observer/src/logger/sinks/stdout.ts`
- Create: `packages/observer/src/logger/sinks/memory.ts`
- Modify: `packages/observer/src/logger/index.ts`
- Test: `packages/observer/src/logger/__tests__/logger.test.ts`

- [ ] **Step 1: 先补 sink 测试，锁定文件写出和 memory 断言行为**

```ts
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createJsonlFileSink, createMemorySink, createObserverLogger } from '../index.js'

describe('observer sinks', () => {
  it('writes CLI-compatible JSONL entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'observer-'))
    const filePath = join(dir, 'tianji.log')
    const logger = createObserverLogger({
      sinks: [createJsonlFileSink({ filePath })],
    })

    await logger.info(['cli', 'run'], 'completed', { runId: 'run_test' })

    const lines = (await readFile(filePath, 'utf8')).trim().split('\n')
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'info',
      scope: ['cli', 'run'],
      message: 'completed',
      data: { runId: 'run_test' },
    })
  })

  it('stores entries in memory sink for assertions', async () => {
    const sink = createMemorySink()
    await sink.write({
      timestamp: '2026-03-30T00:00:00.000Z',
      level: 'info',
      scope: ['cli'],
      message: 'message',
    })

    expect(sink.entries).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 运行 sink 测试确认当前失败**

Run: `pnpm --filter @tianji/observer test -- --run packages/observer/src/logger/__tests__/logger.test.ts`
Expected: FAIL，缺少 sink 实现。

- [ ] **Step 3: 写最小 sink 实现**

```ts
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export function createJsonlFileSink(options: { filePath: string }): ObserverLogSink {
  return {
    async write(entry) {
      await mkdir(dirname(options.filePath), { recursive: true })
      await appendFile(options.filePath, `${JSON.stringify(entry)}\n`, 'utf8')
    },
  }
}
```

```ts
export interface ObserverMemorySink extends ObserverLogSink {
  readonly entries: ObserverLogEntry[]
}

export function createMemorySink(): ObserverMemorySink {
  const entries: ObserverLogEntry[] = []
  return {
    entries,
    async write(entry) {
      entries.push(entry)
    },
  }
}
```

```ts
export function createStdoutSink(options: { pretty?: boolean } = {}): ObserverLogSink {
  return {
    async write(entry) {
      const line = options.pretty === true
        ? `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.scope.join(' > ')} ${entry.message}${entry.data === undefined ? '' : ` ${JSON.stringify(entry.data)}`}`
        : JSON.stringify(entry)

      process.stdout.write(`${line}\n`)
    },
  }
}
```

- [ ] **Step 4: 运行 sink 测试确认通过**

Run: `pnpm --filter @tianji/observer test -- --run packages/observer/src/logger/__tests__/logger.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 sink 实现**

```bash
git add packages/observer/src/logger/sinks/file-jsonl.ts packages/observer/src/logger/sinks/stdout.ts packages/observer/src/logger/sinks/memory.ts packages/observer/src/logger/index.ts packages/observer/src/logger/__tests__/logger.test.ts
git commit -m "$(cat <<'EOF'
feat(observer): 增加多 sink 日志输出能力

为什么需要这个改动：
observer 需要同时支持 CLI JSONL 文件写入、本地 stdout 输出和测试断言场景。
没有多 sink 抽象，就无法在保持 CLI 兼容的同时提供可测试和可扩展的日志基础设施。

技术实现：
- 新增 JSONL file sink，兼容 CLI 现有日志文件格式
- 新增 stdout sink，支持结构化或 pretty 输出
- 新增 memory sink，便于单元测试断言日志 entry
- 补充 sink 行为测试，覆盖文件写入和内存收集

解决的问题：
observer 具备了面向 CLI、开发态和测试场景的统一日志分发能力。

相关信息：
- 影响范围: observer sink 实现与测试能力
EOF
)"
```

### Task 5: 实现 tracing 状态、初始化和 span helper

**Files:**
- Create: `packages/observer/src/tracing/types.ts`
- Create: `packages/observer/src/tracing/state.ts`
- Create: `packages/observer/src/tracing/tracer.ts`
- Create: `packages/observer/src/tracing/spans.ts`
- Create: `packages/observer/src/tracing/index.ts`
- Modify: `packages/observer/src/index.ts`
- Test: `packages/observer/src/tracing/__tests__/tracing.test.ts`

- [ ] **Step 1: 先写 tracing 单元测试，覆盖 disabled 和生命周期**

```ts
import { describe, expect, it } from 'vitest'

import { getTracer, initTracing, isTracingEnabled, shutdownTracing } from '../index.js'

describe('observer tracing', () => {
  it('returns undefined tracer before init', () => {
    expect(isTracingEnabled()).toBe(false)
    expect(getTracer()).toBeUndefined()
  })

  it('initializes and shuts down without unexpected errors', async () => {
    const dispose = initTracing({ serviceName: 'tianji-cli', exporters: [] })

    expect(isTracingEnabled()).toBe(true)
    expect(getTracer('test')).toBeDefined()

    await dispose()
    await shutdownTracing()

    expect(isTracingEnabled()).toBe(false)
  })
})
```

- [ ] **Step 2: 运行 tracing 测试确认当前失败**

Run: `pnpm --filter @tianji/observer test -- --run packages/observer/src/tracing/__tests__/tracing.test.ts`
Expected: FAIL，缺少 tracing 导出和状态实现。

- [ ] **Step 3: 写最小 tracing 基础设施**

```ts
import type { Span, Tracer } from '@opentelemetry/api'

export interface ObserverTracingConfig {
  readonly serviceName: string
  readonly exporters: readonly ObserverTracingExporterConfig[]
}

export interface ObserverTracingExporterConfig {
  readonly kind: 'otlp' | 'langfuse'
  readonly endpoint?: string
  readonly headers?: Record<string, string>
}

export interface ObserverLlmCallSpanInput {
  readonly provider: string
  readonly model: string
  readonly sessionId?: string
  readonly runId?: string
}

let tracingState:
  | {
      readonly tracer: Tracer
      readonly shutdown: () => Promise<void>
    }
  | undefined
```

```ts
export function initTracing(config: ObserverTracingConfig): () => Promise<void> {
  if (tracingState !== undefined) {
    return tracingState.shutdown
  }

  const provider = createObserverTracerProvider(config)
  const tracer = provider.getTracer(config.serviceName)

  tracingState = {
    tracer,
    shutdown: async () => {
      await provider.shutdown()
      tracingState = undefined
    },
  }

  return tracingState.shutdown
}

export function getTracer(name = 'tianji-observer'): Tracer | undefined {
  if (tracingState === undefined) {
    return undefined
  }

  return tracingState.tracer
}
```

```ts
export function startSessionSpan(sessionId: string, parent?: Span): Span | undefined {
  const tracer = getTracer('observer-session')
  return tracer?.startSpan('session', {
    attributes: { 'tianji.session.id': sessionId },
  }, parent === undefined ? undefined : trace.setSpan(context.active(), parent))
}
```

说明：`langfuse` exporter 若第一阶段无法落完整接线，至少保留 config 类型、switch 分支和明确报错，避免 API 反复变更。

- [ ] **Step 4: 运行 tracing 测试确认通过**

Run: `pnpm --filter @tianji/observer test -- --run packages/observer/src/tracing/__tests__/tracing.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 tracing 基础设施**

```bash
git add packages/observer/src/tracing/types.ts packages/observer/src/tracing/state.ts packages/observer/src/tracing/tracer.ts packages/observer/src/tracing/spans.ts packages/observer/src/tracing/index.ts packages/observer/src/index.ts packages/observer/src/tracing/__tests__/tracing.test.ts
git commit -m "$(cat <<'EOF'
feat(observer): 增加 tracing 基础设施入口

为什么需要这个改动：
设计文档要求 observer 在第一阶段就提供 tracing 包结构和初始化入口，避免第二阶段再次重做包边界。
同时 tracing 生命周期必须集中在 observer，不能散落到 runtime 内部偷偷初始化。

技术实现：
- 定义 `ObserverTracingConfig` 和 exporter 配置类型
- 实现 tracing 状态管理、初始化和关闭逻辑
- 增加 session/run/tool/llm-call span helper 入口
- 补充 disabled 行为和生命周期测试

解决的问题：
observer 具备了可显式初始化和关闭的 tracing 基础设施，为后续 runtime 接入预留稳定入口。

相关信息：
- 影响范围: observer tracing 公共 API
EOF
)"
```

### Task 6: 迁移 CLI logger 到 observer 并保持 log follow 兼容

**Files:**
- Modify: `apps/cli/package.json`
- Modify: `apps/cli/src/logger.ts`
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/log-follow.ts`
- Test: `apps/cli/src/__tests__/run-e2e.test.ts`

- [ ] **Step 1: 先写 CLI 回归测试，锁定 observer 迁移后的接口兼容**

```ts
it('keeps CLI log JSONL format after observer migration', async () => {
  const { paths, cleanup } = await createTempCliPaths()

  try {
    const exitCode = await runCli(['run', 'say hello'], {
      loadContext: () => Promise.resolve(createFakeContext({ paths })),
      createSession: () => createStubSession([
        {
          type: 'run.completed',
          runId: 'run_test' as RunId,
          sessionId: 'session_test' as SessionId,
          timestamp: Date.now(),
        },
      ]),
      getUserConfigPaths: () => paths,
    })

    expect(exitCode).toBe(0)

    const rawLog = await readFile(paths.cliLogFilePath, 'utf8')
    const parsed = rawLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(parsed[0]).toMatchObject({
      level: expect.any(String),
      scope: expect.any(Array),
      message: expect.any(String),
    })
  } finally {
    await cleanup()
  }
})
```

- [ ] **Step 2: 运行 CLI 测试确认当前失败**

Run: `pnpm test -- --run src/__tests__/run-e2e.test.ts`
Workdir: `apps/cli`
Expected: FAIL，因 observer 依赖和导出尚未接入。

- [ ] **Step 3: 写最小 CLI 迁移实现**

```ts
import {
  createJsonlFileSink,
  createObserverLogger,
  type ObserverLogEntry,
  type ObserverLogLevel,
  type ObserverLogScope,
} from '@tianji/observer'

export type CliLogEntry = ObserverLogEntry
export type CliLogLevel = Extract<ObserverLogLevel, 'debug' | 'info' | 'warn' | 'error'>
export type CliLogScope = ObserverLogScope

export function createCliLogger(paths: UserConfigPaths): CliLogger {
  const logger = createObserverLogger({
    sinks: [createJsonlFileSink({ filePath: paths.cliLogFilePath })],
  })

  return {
    appendCliLog(entry) {
      return createJsonlFileSink({ filePath: paths.cliLogFilePath }).write(entry)
    },
    logDebug(scope, message, data) {
      return logger.debug(scope, message, data)
    },
    logInfo(scope, message, data) {
      return logger.info(scope, message, data)
    },
    logWarn(scope, message, data) {
      return logger.warn(scope, message, data)
    },
    logError(scope, message, data) {
      return logger.error(scope, message, data)
    },
  }
}
```

```ts
import type { ObserverLogEntry, ObserverLogLevel, ObserverLogScope } from '@tianji/observer'
```

说明：`apps/cli/src/logger.ts` 可保留为 CLI 兼容适配层，避免一次改动过多调用点；但实际写入逻辑必须下沉到 observer。

- [ ] **Step 4: 运行 CLI 回归测试确认通过**

Run: `pnpm test -- --run src/__tests__/run-e2e.test.ts`
Workdir: `apps/cli`
Expected: PASS

- [ ] **Step 5: 提交 CLI 迁移**

```bash
git add apps/cli/package.json apps/cli/src/logger.ts apps/cli/src/main.ts apps/cli/src/log-follow.ts apps/cli/src/__tests__/run-e2e.test.ts
git commit -m "$(cat <<'EOF'
refactor(cli): 迁移 CLI 日志实现到 observer

为什么需要这个改动：
当前 CLI 自带本地日志实现，导致日志协议、脱敏规则和写入方式无法被其他包复用。
将 CLI 日志迁移到 observer，才能把 JSONL 兼容能力沉到统一包边界。

技术实现：
- 为 CLI 添加 `@tianji/observer` 依赖
- 将 `apps/cli/src/logger.ts` 改为 observer 适配层
- 在 `main.ts` 中使用 observer JSONL file sink 创建 logger
- `log-follow.ts` 改用 observer 导出的日志类型
- 补充 CLI 回归测试，确认日志格式与 follow 行为保持兼容

解决的问题：
CLI 不再维护私有日志实现，同时继续保持 `tianji log -f` 和既有日志文件兼容。

相关信息：
- 影响范围: CLI 日志写入与日志跟随流程
EOF
)"
```

### Task 7: 为 runtime 预留 observer 边界但不扩大行为变更

**Files:**
- Modify: `packages/runtime/src/runtime.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/src/__tests__/runtime-public-api.test.ts`

- [ ] **Step 1: 先写 runtime 公共 API 测试，锁定 observer logger 入口只作为可选边界**

```ts
import type { ObserverLogger } from '@tianji/observer'

import type { SessionRuntimeOptions } from '../index.js'

declare const logger: ObserverLogger

const options: SessionRuntimeOptions = {
  deepagents: {
    model: 'openai/gpt-5',
  },
  logger,
}

void options
```

- [ ] **Step 2: 运行 runtime 类型检查确认当前失败**

Run: `pnpm test -- --run src/__tests__/runtime-public-api.test.ts`
Workdir: `packages/runtime`
Expected: FAIL 或 type error，`SessionRuntimeOptions` 尚未包含 `logger`。

- [ ] **Step 3: 写最小 runtime 边界类型实现**

```ts
import type { ObserverLogger } from '@tianji/observer'

export interface SessionRuntimeOptions {
  readonly engine?: Extract<SessionRuntimeEngine, 'deepagents'>
  readonly deepagents?: SessionRuntimeDeepagentsConfig
  readonly snapshotStore?: SnapshotStore
  readonly toolCatalog?: ToolCatalog | ToolRegistry | readonly RuntimeToolDefinition[]
  readonly logger?: ObserverLogger
}
```

说明：本任务只增加类型入口，不新增实际日志写入调用，不更改 `createSessionRuntime()` 运行逻辑。

- [ ] **Step 4: 运行 runtime 公共 API 测试确认通过**

Run: `pnpm test -- --run src/__tests__/runtime-public-api.test.ts`
Workdir: `packages/runtime`
Expected: PASS

- [ ] **Step 5: 提交 runtime 边界类型**

```bash
git add packages/runtime/src/runtime.ts packages/runtime/src/index.ts packages/runtime/src/__tests__/runtime-public-api.test.ts
git commit -m "$(cat <<'EOF'
feat(runtime): 预留 observer logger 接入边界

为什么需要这个改动：
设计文档要求第一阶段不要大规模改 runtime 行为，但要提前为 observer 接入留出清晰边界。
如果不先补齐类型入口，后续 runtime 接 observer 时仍需要改公共 API。

技术实现：
- 在 `SessionRuntimeOptions` 中新增可选 `logger?: ObserverLogger`
- 更新 runtime 对外类型导出
- 补充公共 API 测试，确认 observer logger 可作为可选配置传入

解决的问题：
runtime 获得了明确的 observer 接入扩展点，同时避免本阶段扩大行为变更范围。

相关信息：
- 影响范围: runtime 公共类型边界
EOF
)"
```

### Task 8: 更新 README 与使用说明

**Files:**
- Modify: `README.md`
- Modify: `apps/cli/README.md`
- Modify: `packages/runtime/README.md`
- Create: `packages/observer/README.md`

- [ ] **Step 1: 先写文档变更清单，确保设计要求全部覆盖**

```md
- 根 README 增加 `packages/observer` 到仓库结构和核心包说明。
- 根 README 的 CLI 日志章节改为 observer 统一提供。
- CLI README 的日志章节改写为 observer 负责 JSONL 生成，CLI 负责 follow 和渲染。
- runtime README 增加后续可接入 `logger?: ObserverLogger` 的公共边界说明。
- observer README 说明 logger API、JSONL sink、memory sink、stdout sink 和 tracing 初始化方式。
```

- [ ] **Step 2: 人工校对现有文档再开始修改**

Read and verify:
- `README.md`
- `apps/cli/README.md`
- `packages/runtime/README.md`

Expected: 确认当前文档仍把日志描述成 CLI 私有实现，observer README 尚不存在。

- [ ] **Step 3: 写最小文档更新**

```md
### `@tianji/observer`

统一的可观测性包，提供领域化 logger API、CLI 兼容 JSONL file sink，以及显式 tracing 初始化能力。第一阶段主要承接 CLI 日志输出，并为 runtime 后续接入保留稳定边界。
```

```md
## 日志系统

CLI 运行日志由 `@tianji/observer` 统一生成并写入 `~/.config/tianji-ai/logs/tianji.log`。`@tianji/cli` 只负责在 `tianji log -f` 中 follow 该文件并渲染为可读文本。
```

```md
## 使用示例

```ts
import { createJsonlFileSink, createObserverLogger, initTracing } from '@tianji/observer'

const logger = createObserverLogger({
  sinks: [createJsonlFileSink({ filePath: '/tmp/tianji.log' })],
})

await logger.info(['cli', 'run'], 'Loaded user config', { agentName: 'default' })

const shutdownTracing = initTracing({
  serviceName: 'tianji-cli',
  exporters: [],
})

await shutdownTracing()
```
```

- [ ] **Step 4: 校对文档内容与实现一致**

Run: `pnpm check`
Expected: PASS，且 README 中的包列表、示例 import、命令与实际导出一致。

- [ ] **Step 5: 提交文档更新**

```bash
git add README.md apps/cli/README.md packages/runtime/README.md packages/observer/README.md
git commit -m "$(cat <<'EOF'
docs(observer): 更新 observer 与 CLI 日志文档

为什么需要这个改动：
代码迁移到 observer 后，仓库说明和 CLI 日志描述如果仍停留在旧实现，会让后续维护者误判真实边界。
需要同步 README，确保包职责、日志来源和 tracing 初始化方式与实现一致。

技术实现：
- 在根 README 中加入 `@tianji/observer` 包说明和仓库结构
- 更新 CLI README，把日志实现描述改为 observer 统一提供
- 更新 runtime README，说明后续可接入 observer logger 边界
- 新增 observer README，说明 logger API、sink 和 tracing 用法

解决的问题：
文档与代码边界重新对齐，降低后续接手成本和误用风险。

相关信息：
- 影响范围: 仓库文档与包说明
EOF
)"
```

### Task 9: 全量验证与收尾

**Files:**
- Modify: `packages/observer/package.json`
- Modify: `apps/cli/package.json`
- Modify: `packages/runtime/package.json`
- Test: `packages/observer/src/logger/__tests__/logger.test.ts`
- Test: `packages/observer/src/tracing/__tests__/tracing.test.ts`
- Test: `apps/cli/src/__tests__/run-e2e.test.ts`
- Test: `packages/runtime/src/__tests__/runtime-public-api.test.ts`

- [ ] **Step 1: 运行 observer 包内测试**

Run: `pnpm test -- --run src/logger/__tests__/logger.test.ts src/tracing/__tests__/tracing.test.ts`
Workdir: `packages/observer`
Expected: PASS

- [ ] **Step 2: 运行 CLI 回归测试**

Run: `pnpm test -- --run src/__tests__/run-e2e.test.ts`
Workdir: `apps/cli`
Expected: PASS

- [ ] **Step 3: 运行 runtime 公共 API 回归测试**

Run: `pnpm test -- --run src/__tests__/runtime-public-api.test.ts`
Workdir: `packages/runtime`
Expected: PASS

- [ ] **Step 4: 在仓库根目录执行强制检查**

Run: `pnpm check`
Expected: PASS，且无 error、warning 或 info 残留。

- [ ] **Step 5: 提交最终收尾**

```bash
git add packages/observer package.json apps/cli packages/runtime README.md
git commit -m "$(cat <<'EOF'
feat(observer): 落地 observer 包并接管 CLI 日志

为什么需要这个改动：
仓库需要一个统一的 observer 包承接 logger 与 tracing 能力，同时保持 CLI JSONL 日志兼容。
这次收尾提交用于汇总 observer 包落地、CLI 迁移、runtime 边界预留和文档同步后的最终状态。

技术实现：
- 新增 observer package 及 logger/tracing 基础设施
- 实现 JSONL file sink、stdout sink 和 memory sink
- 将 CLI 日志迁移到 observer 并保留 `log -f` 兼容行为
- 为 runtime 补充 observer logger 可选边界
- 更新相关 README 并完成全量检查

解决的问题：
仓库拥有了统一的可观测性包，CLI 日志能力不再是局部实现，后续 runtime 接入也有了清晰起点。

相关信息：
- 影响范围: observer、cli、runtime 与仓库文档
EOF
)"
```

## 自检结果

- Spec coverage：已覆盖 observer 包结构、logger API、多 sink、脱敏、CLI 迁移、tracing 基础设施、runtime 边界预留、README 更新和 `pnpm check` 验证。
- Placeholder scan：已移除 `TODO`、`TBD` 和“按需处理”类空泛描述；每个任务都给出了文件路径、示例代码和验证命令。
- Type consistency：计划中统一使用 `ObserverLogEntry`、`ObserverLogger`、`ObserverTracingConfig`、`SessionRuntimeOptions.logger`，与设计文档命名保持一致。

Plan complete and saved to `docs/superpowers/plans/2026-03-30-observer-package-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
