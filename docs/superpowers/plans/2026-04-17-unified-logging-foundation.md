# Unified Logging Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 observer 包的错误归一化与 stderr 输出能力，收紧 `createEventBus` 的错误汇约束，为 controlplane 顶层补上崩溃日志防线，使日志链路具备"Error 全量展开 + 致命错误同时落文件与 stderr + bus 绝不走 console"这三个基础不变量。

**Architecture:**
- Observer 包承担 **唯一日志出口**：新增 stderr sink（可按级别过滤），扩展 `sanitizeObserverLogData` 与独立 `errorToLogData` 工具，使 Error 的 `name/message/stack/cause` 链路在日志落盘时完整保留。
- `@tianji/shared/bus` 的默认 `errorSink` 取消，`errorSink` 改为必填，禁止任何新使用者无感走 `console.error`。
- `apps/controlplane/src/server.ts` 仿照 `apps/node/src/daemon-entry.ts` 补齐 `uncaughtException` / `unhandledRejection` handler，shutdown 链加超时与 try/catch，并把 logger sinks 改成"文件 + stderr(minLevel='warn')"双写。

**Tech Stack:** TypeScript (strict, ESM)、Vitest、Node 22、Hono、better-sqlite3。`pnpm check` 统一入口，各包 `pnpm --filter <pkg> test` 单独跑。

**Scope Caveat:** 本 plan 只做上述四项基础设施改动，**不动** `apps/node` 的 logger 迁移、`apps/node/src/controlplane/connection-loop.ts` 的 bare catch 清理、16 处 `.message : String` 旧写法替换、`packages/agent/src/acp-entry.ts` 的 console.error 替换。这些留给 `docs/superpowers/plans/2026-04-17-unified-logging-migration.md`（下一份）。本 plan 完成后，上述消费侧改造才具备可依赖的基础。

---

## File Structure

**新增：**
- `packages/observer/src/logger/level.ts` —— `ObserverLogLevel` 的比较工具（`LOG_LEVEL_ORDER`、`isLevelAtLeast`）
- `packages/observer/src/logger/error-formatter.ts` —— `errorToLogData(err, options?)`，递归展开 `cause`，含最大深度守卫
- `packages/observer/src/logger/__tests__/error-formatter.test.ts`
- `packages/observer/src/logger/__tests__/level.test.ts`
- `packages/observer/src/logger/sinks/stderr.ts` —— `createStderrSink({ pretty?, minLevel? })`
- `packages/observer/src/logger/__tests__/stderr-sink.test.ts`

**修改：**
- `packages/observer/src/logger/sanitize.ts` —— Error 归一化保留 `stack` 和 `cause`（递归）
- `packages/observer/src/logger/__tests__/logger.test.ts` —— 调整用例以匹配扩展后的 Error 字段
- `packages/observer/src/logger/index.ts` —— 导出 `createStderrSink` / `errorToLogData` / 级别工具
- `packages/observer/src/index.ts` —— 顶层再导出
- `packages/shared/src/bus/types.ts` / `packages/shared/src/bus/bus.ts` —— `EventBusOptions.errorSink` 改为必填并删掉 `defaultErrorSink`
- `packages/shared/src/__tests__/bus.test.ts`（若有；不确定时先 grep）
- `apps/controlplane/src/server.ts` —— shutdown 加超时、加崩溃 handler、logger sinks 扩展为 `[file, stderr({ minLevel:'warn' })]`
- `apps/controlplane/src/__tests__/server-shutdown.test.ts`（新增）

**不改动：**
- `apps/node/**`（留给下一份 plan）
- `packages/agent/**`（留给下一份 plan）
- `apps/controlplane/src/services/**`、`routes/**`（只改 server.ts 顶层）

---

## Task 1: `errorToLogData` 工具 + `sanitize` 保留 stack/cause

**Files:**
- Create: `packages/observer/src/logger/error-formatter.ts`
- Create: `packages/observer/src/logger/__tests__/error-formatter.test.ts`
- Modify: `packages/observer/src/logger/sanitize.ts`
- Modify: `packages/observer/src/logger/__tests__/logger.test.ts`
- Modify: `packages/observer/src/logger/index.ts`
- Modify: `packages/observer/src/index.ts`

### Step 1.1 — 写 error-formatter 的失败测试

- [ ] Create `packages/observer/src/logger/__tests__/error-formatter.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { errorToLogData } from '../error-formatter.js'

describe('errorToLogData', () => {
  it('returns name / message / stack for Error instances', () => {
    const err = new Error('boom')
    const data = errorToLogData(err)
    expect(data.name).toBe('Error')
    expect(data.message).toBe('boom')
    expect(typeof data.stack).toBe('string')
    expect(data.stack).toContain('boom')
  })

  it('preserves custom error subclass name', () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message)
        this.name = 'CustomError'
      }
    }
    const data = errorToLogData(new CustomError('oops'))
    expect(data.name).toBe('CustomError')
  })

  it('recursively expands cause chain', () => {
    const root = new Error('root')
    const mid = new Error('mid', { cause: root })
    const top = new Error('top', { cause: mid })

    const data = errorToLogData(top)
    const causeMid = data.cause as Record<string, unknown>
    const causeRoot = causeMid.cause as Record<string, unknown>

    expect(data.message).toBe('top')
    expect(causeMid.message).toBe('mid')
    expect(causeRoot.message).toBe('root')
    expect(causeRoot.cause).toBeUndefined()
  })

  it('stops recursion at maxDepth to avoid infinite loops', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    ;(a as unknown as { cause: Error }).cause = b

    const data = errorToLogData(a, { maxDepth: 2 })
    expect(data.message).toBe('a')
    const firstCause = data.cause as Record<string, unknown>
    expect(firstCause.message).toBe('b')
    expect(firstCause.cause).toBe('[truncated: maxDepth reached]')
  })

  it('returns string fallback for non-Error primitives', () => {
    expect(errorToLogData('plain string')).toEqual({ message: 'plain string' })
    expect(errorToLogData(42)).toEqual({ message: '42' })
    expect(errorToLogData(null)).toEqual({ message: 'null' })
    expect(errorToLogData(undefined)).toEqual({ message: 'undefined' })
  })

  it('json-serializes plain object rejections', () => {
    const data = errorToLogData({ code: 'ECONNREFUSED', port: 3000 })
    expect(data.message).toContain('ECONNREFUSED')
    expect(data.message).toContain('3000')
  })
})
```

- [ ] Run test, expect FAIL:

```bash
cd /workspaces/dev_docker/tianji-ai/packages/observer && pnpm test error-formatter
```

Expected: fails with `Cannot find module '../error-formatter.js'`.

### Step 1.2 — 实现 `error-formatter.ts`

- [ ] Create `packages/observer/src/logger/error-formatter.ts`:

```ts
/**
 * 将任意抛出值归一化为可写入日志的结构化数据。
 * - Error: 保留 name / message / stack，并递归展开 cause。
 * - 非 Error：`{ message }`，对普通对象走 JSON 序列化。
 *
 * @module logger/error-formatter
 */

export interface ErrorToLogDataOptions {
  /** 递归展开 cause 的最大深度，默认 5，防止自引用导致死循环。 */
  readonly maxDepth?: number
}

const DEFAULT_MAX_DEPTH = 5

/** 归一化入口。 */
export function errorToLogData(
  err: unknown,
  options: ErrorToLogDataOptions = {}
): Record<string, unknown> {
  return formatAtDepth(err, options.maxDepth ?? DEFAULT_MAX_DEPTH)
}

function formatAtDepth(err: unknown, remainingDepth: number): Record<string, unknown> {
  if (remainingDepth <= 0) {
    return { message: '[truncated: maxDepth reached]' }
  }

  if (err instanceof Error) {
    const data: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    }
    if (typeof err.stack === 'string') {
      data.stack = err.stack
    }
    if (err.cause !== undefined) {
      const nestedDepth = remainingDepth - 1
      data.cause =
        nestedDepth <= 0
          ? '[truncated: maxDepth reached]'
          : formatAtDepth(err.cause, nestedDepth)
    }
    return data
  }

  if (typeof err === 'string') {
    return { message: err }
  }

  if (err === null || err === undefined) {
    return { message: String(err) }
  }

  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
    return { message: String(err) }
  }

  try {
    return { message: JSON.stringify(err) }
  } catch {
    return { message: Object.prototype.toString.call(err) }
  }
}
```

- [ ] Run test, expect PASS:

```bash
cd /workspaces/dev_docker/tianji-ai/packages/observer && pnpm test error-formatter
```

Expected: all `errorToLogData` cases green.

### Step 1.3 — 扩展 `sanitize.ts` 保留 stack / cause

`sanitize.ts` 里 `sanitizeValue` 目前对 Error 直接 `{ name, message }`，丢掉 stack 与 cause。改为委托给 `errorToLogData`（保持 stack、cause 全量），同时 cause 链里仍然按 sensitiveKeys 继续脱敏是不必要的（cause 本身不是用户 payload）。保留逻辑：stack / cause 不参与 sensitiveKeys 过滤。

- [ ] Modify `packages/observer/src/logger/sanitize.ts:24-30`:

找到：

```ts
function sanitizeValue(value: unknown, sensitiveKeySet: ReadonlySet<string>): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    }
  }
```

替换为：

```ts
function sanitizeValue(value: unknown, sensitiveKeySet: ReadonlySet<string>): unknown {
  if (value instanceof Error) {
    return errorToLogData(value)
  }
```

- [ ] 在 `sanitize.ts` 顶部 `const DEFAULT_SENSITIVE_KEYS ...` 上方加入 import:

```ts
import { errorToLogData } from './error-formatter.js'
```

### Step 1.4 — 更新 `logger.test.ts` 对齐新字段

原测试断言 `error: { name: 'Error', message: 'boom' }`。新行为会额外包含 `stack`。改为 objectContaining。

- [ ] Modify `packages/observer/src/logger/__tests__/logger.test.ts:40-45`:

找到：

```ts
    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0]?.data).toEqual({
      nested: { keep: true },
      error: { name: 'Error', message: 'boom' },
    })
```

替换为：

```ts
    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0]?.data).toEqual({
      nested: { keep: true },
      error: expect.objectContaining({
        name: 'Error',
        message: 'boom',
        stack: expect.any(String),
      }),
    })
```

### Step 1.5 — 导出新符号

- [ ] Modify `packages/observer/src/logger/index.ts`，在现有 export 列表最末尾追加：

```ts
export { errorToLogData } from './error-formatter.js'
export type { ErrorToLogDataOptions } from './error-formatter.js'
```

- [ ] Modify `packages/observer/src/index.ts`，在 `export { ... } from './logger/index.js'` 的符号列表（当前 lines 9-18）内追加 `errorToLogData`，并在类型 re-export 块（当前 lines 20-22）追加：

```ts
export type { ErrorToLogDataOptions } from './logger/index.js'
```

完整参考形状：

```ts
export {
  createJsonlFileSink,
  createObserverLogger,
  createMemorySink,
  createStdoutSink,
  errorToLogData,
  formatEnvelopeLog,
  getDefaultObserverSensitiveKeys,
  sanitizeObserverLogData,
  subscribeEventBusLogger,
} from './logger/index.js'

export type { CreateJsonlFileSinkOptions } from './logger/index.js'
export type { ErrorToLogDataOptions } from './logger/index.js'
export type { ObserverMemorySink } from './logger/index.js'
export type { CreateStdoutSinkOptions } from './logger/index.js'
```

### Step 1.6 — 跑包级测试与全局 check

- [ ] Run:

```bash
cd /workspaces/dev_docker/tianji-ai/packages/observer && pnpm test
```

Expected: 全部 PASS，含新增 `error-formatter` 与修改过的 `logger.test.ts`。

- [ ] Run:

```bash
cd /workspaces/dev_docker/tianji-ai && pnpm check
```

Expected: 退出码 0，无 error / warning / info。

### Step 1.7 — Commit

先加载 git-commit skill。

- [ ] Commit:

```bash
cd /workspaces/dev_docker/tianji-ai && \
git add packages/observer/src/logger/error-formatter.ts \
        packages/observer/src/logger/__tests__/error-formatter.test.ts \
        packages/observer/src/logger/sanitize.ts \
        packages/observer/src/logger/__tests__/logger.test.ts \
        packages/observer/src/logger/index.ts \
        packages/observer/src/index.ts && \
git commit -m "feat(observer): 新增 errorToLogData 并让 sanitize 保留 stack/cause"
```

---

## Task 2: `createStderrSink` 与级别过滤工具

**Files:**
- Create: `packages/observer/src/logger/level.ts`
- Create: `packages/observer/src/logger/__tests__/level.test.ts`
- Create: `packages/observer/src/logger/sinks/stderr.ts`
- Create: `packages/observer/src/logger/__tests__/stderr-sink.test.ts`
- Modify: `packages/observer/src/logger/index.ts`
- Modify: `packages/observer/src/index.ts`

### Step 2.1 — 写 level 比较工具的失败测试

- [ ] Create `packages/observer/src/logger/__tests__/level.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { LOG_LEVEL_ORDER, isLevelAtLeast } from '../level.js'

describe('LOG_LEVEL_ORDER', () => {
  it('orders levels from trace (lowest) to fatal (highest)', () => {
    expect(LOG_LEVEL_ORDER.trace).toBeLessThan(LOG_LEVEL_ORDER.debug)
    expect(LOG_LEVEL_ORDER.debug).toBeLessThan(LOG_LEVEL_ORDER.info)
    expect(LOG_LEVEL_ORDER.info).toBeLessThan(LOG_LEVEL_ORDER.warn)
    expect(LOG_LEVEL_ORDER.warn).toBeLessThan(LOG_LEVEL_ORDER.error)
    expect(LOG_LEVEL_ORDER.error).toBeLessThan(LOG_LEVEL_ORDER.fatal)
  })
})

describe('isLevelAtLeast', () => {
  it('returns true when actual level >= threshold', () => {
    expect(isLevelAtLeast('error', 'warn')).toBe(true)
    expect(isLevelAtLeast('fatal', 'error')).toBe(true)
    expect(isLevelAtLeast('info', 'info')).toBe(true)
  })

  it('returns false when actual level < threshold', () => {
    expect(isLevelAtLeast('debug', 'warn')).toBe(false)
    expect(isLevelAtLeast('trace', 'info')).toBe(false)
  })
})
```

- [ ] Run, expect FAIL:

```bash
cd /workspaces/dev_docker/tianji-ai/packages/observer && pnpm test level
```

### Step 2.2 — 实现 level 比较工具

- [ ] Create `packages/observer/src/logger/level.ts`:

```ts
import type { ObserverLogLevel } from './types.js'

/**
 * 各日志级别的数值权重，用于级别过滤比较。
 * 数值越大代表越严重，`fatal` 为最高。
 */
export const LOG_LEVEL_ORDER: Readonly<Record<ObserverLogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

/**
 * 判断 `actual` 的严重程度是否不低于 `threshold`。
 *
 * @param actual - 当前日志条目的级别
 * @param threshold - 允许通过的最低级别
 */
export function isLevelAtLeast(actual: ObserverLogLevel, threshold: ObserverLogLevel): boolean {
  return LOG_LEVEL_ORDER[actual] >= LOG_LEVEL_ORDER[threshold]
}
```

- [ ] Run, expect PASS:

```bash
cd /workspaces/dev_docker/tianji-ai/packages/observer && pnpm test level
```

### Step 2.3 — 写 stderr sink 的失败测试

- [ ] Create `packages/observer/src/logger/__tests__/stderr-sink.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createStderrSink } from '../sinks/stderr.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createStderrSink', () => {
  it('writes JSON line to process.stderr by default', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const sink = createStderrSink()

    await sink.write({
      timestamp: '2026-04-17T00:00:00.000Z',
      level: 'error',
      scope: ['cp'],
      message: 'boom',
    })

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const written = writeSpy.mock.calls[0]?.[0] as string
    expect(written.endsWith('\n')).toBe(true)
    expect(JSON.parse(written.trimEnd())).toMatchObject({
      level: 'error',
      message: 'boom',
    })
  })

  it('supports pretty formatting', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const sink = createStderrSink({ pretty: true })

    await sink.write({
      timestamp: '2026-04-17T00:00:00.000Z',
      level: 'warn',
      scope: ['cp', 'server'],
      message: 'slow',
    })

    const written = writeSpy.mock.calls[0]?.[0] as string
    expect(written).toContain('[warn]')
    expect(written).toContain('cp.server')
    expect(written).toContain('slow')
  })

  it('filters entries below minLevel', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const sink = createStderrSink({ minLevel: 'warn' })

    await sink.write({
      timestamp: '2026-04-17T00:00:00.000Z',
      level: 'info',
      scope: ['cp'],
      message: 'noise',
    })
    expect(writeSpy).not.toHaveBeenCalled()

    await sink.write({
      timestamp: '2026-04-17T00:00:00.000Z',
      level: 'error',
      scope: ['cp'],
      message: 'real',
    })
    expect(writeSpy).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] Run, expect FAIL:

```bash
cd /workspaces/dev_docker/tianji-ai/packages/observer && pnpm test stderr-sink
```

### Step 2.4 — 实现 stderr sink

- [ ] Create `packages/observer/src/logger/sinks/stderr.ts`:

```ts
import type { ObserverLogEntry, ObserverLogLevel, ObserverLogSink } from '../types.js'

import { isLevelAtLeast } from '../level.js'

export interface CreateStderrSinkOptions {
  readonly pretty?: boolean
  /** 仅输出严重程度不低于该级别的日志条目。未指定时不过滤。 */
  readonly minLevel?: ObserverLogLevel
}

/**
 * 创建一个将日志写入 `process.stderr` 的 sink。
 * 语义与 `createStdoutSink` 一致，唯一差别是默认输出口为 stderr，
 * 通常用于让顶层崩溃、fatal/error 日志与常规 stdout 业务输出分离。
 */
export function createStderrSink(options: CreateStderrSinkOptions = {}): ObserverLogSink {
  const { pretty = false, minLevel } = options
  return {
    async write(entry) {
      if (minLevel !== undefined && !isLevelAtLeast(entry.level, minLevel)) {
        return
      }
      const line = pretty ? formatPrettyEntry(entry) : JSON.stringify(entry)
      process.stderr.write(`${line}\n`)
    },
  }
}

function formatPrettyEntry(entry: ObserverLogEntry): string {
  const scope = entry.scope.join('.')
  const data = entry.data === undefined ? '' : ` ${JSON.stringify(entry.data)}`

  return `[${entry.level}] ${scope} ${entry.message}${data}`
}
```

- [ ] Run, expect PASS:

```bash
cd /workspaces/dev_docker/tianji-ai/packages/observer && pnpm test stderr-sink
```

### Step 2.5 — 导出新符号

- [ ] Modify `packages/observer/src/logger/index.ts`，在现有 export 后追加：

```ts
export { createStderrSink } from './sinks/stderr.js'
export type { CreateStderrSinkOptions } from './sinks/stderr.js'
export { LOG_LEVEL_ORDER, isLevelAtLeast } from './level.js'
```

- [ ] Modify `packages/observer/src/index.ts`，在 value re-export 块追加 `createStderrSink / isLevelAtLeast / LOG_LEVEL_ORDER`，在类型 re-export 块追加 `CreateStderrSinkOptions`：

```ts
export {
  createJsonlFileSink,
  createObserverLogger,
  createMemorySink,
  createStderrSink,
  createStdoutSink,
  errorToLogData,
  formatEnvelopeLog,
  getDefaultObserverSensitiveKeys,
  isLevelAtLeast,
  LOG_LEVEL_ORDER,
  sanitizeObserverLogData,
  subscribeEventBusLogger,
} from './logger/index.js'

export type { CreateJsonlFileSinkOptions } from './logger/index.js'
export type { CreateStderrSinkOptions } from './logger/index.js'
export type { CreateStdoutSinkOptions } from './logger/index.js'
export type { ErrorToLogDataOptions } from './logger/index.js'
export type { ObserverMemorySink } from './logger/index.js'
```

### Step 2.6 — 包级测试与全局 check

- [ ] Run:

```bash
cd /workspaces/dev_docker/tianji-ai/packages/observer && pnpm test
```

Expected: 全部 PASS。

- [ ] Run:

```bash
cd /workspaces/dev_docker/tianji-ai && pnpm check
```

Expected: 退出码 0。

### Step 2.7 — Commit

先加载 git-commit skill。

- [ ] Commit:

```bash
cd /workspaces/dev_docker/tianji-ai && \
git add packages/observer/src/logger/level.ts \
        packages/observer/src/logger/__tests__/level.test.ts \
        packages/observer/src/logger/sinks/stderr.ts \
        packages/observer/src/logger/__tests__/stderr-sink.test.ts \
        packages/observer/src/logger/index.ts \
        packages/observer/src/index.ts && \
git commit -m "feat(observer): 新增 stderr sink 与级别过滤工具"
```

---

## Task 3: `createEventBus` 的 `errorSink` 改为必填

**Files:**
- Modify: `packages/shared/src/bus/bus.ts`（目前 lines 39-47 的 options 定义、92-100 的 defaultErrorSink）
- Modify: `packages/shared/src/bus/types.ts`（若 `EventBusOptions` 或 `ErrorSink` 定义在 types 里需同步）
- 使用方已传 errorSink，无需修改，但需要二次核对：
  - `apps/controlplane/src/server.ts:48-62`
  - `apps/node/src/daemon-entry.ts:59-72`

### Step 3.1 — 核对使用方

- [ ] Run:

```bash
cd /workspaces/dev_docker/tianji-ai && grep -rn "createEventBus(" --include="*.ts" --include="*.tsx" apps packages
```

Expected: 命中集合与以下一致（若不一致，先找出未传 errorSink 的使用方并在本 task 内补齐再继续）：

- `apps/controlplane/src/server.ts`
- `apps/node/src/daemon-entry.ts`
- 若有测试调用方（如 `packages/shared/src/__tests__/bus.test.ts`）

### Step 3.2 — 写收紧后的失败测试

本 task 的"失败测试"是类型层面的：让新约束在编译期可见。做法：找到 `packages/shared/src/__tests__/` 下现有 bus 测试文件（若无则创建 `bus-options.test.ts`），加入一个 **运行时** 用例，验证调用时必须传 errorSink —— 因为 TS 编译期的必填会被 `pnpm check` 覆盖，运行时断言作为双保险。

- [ ] Run:

```bash
cd /workspaces/dev_docker/tianji-ai && ls packages/shared/src/__tests__/
```

若已有 `bus.test.ts` 则在其末尾追加下面用例；若没有，新建 `packages/shared/src/__tests__/bus-options.test.ts`：

```ts
import { describe, expect, it } from 'vitest'

import { createEventBus } from '../bus/bus.js'

describe('createEventBus options contract', () => {
  it('accepts a required errorSink', () => {
    const bus = createEventBus({
      lagSink: () => undefined,
      errorSink: () => undefined,
    })
    expect(typeof bus.publish).toBe('function')
  })

  it('rejects calls that omit errorSink at runtime', () => {
    expect(() => {
      // @ts-expect-error errorSink is required
      createEventBus({ lagSink: () => undefined })
    }).toThrow()
  })
})
```

- [ ] Run test, expect:
  - 类型层会报 `@ts-expect-error` 未命中（因为目前 errorSink 是可选的）。
  - 运行时 `rejects calls that omit errorSink at runtime` 会 FAIL。

```bash
cd /workspaces/dev_docker/tianji-ai/packages/shared && pnpm test bus-options
```

### Step 3.3 — 实现收紧

- [ ] Modify `packages/shared/src/bus/bus.ts:39-47`:

找到：

```ts
export interface EventBusOptions {
  readonly lagSink: LagSink
  /**
   * 订阅者 handler 抛出异常时调用，用于记录可观测日志。
   * 不提供时默认使用 console.error 输出结构化信息。
   * 不得 rethrow，异常隔离是 bus 的核心不变量。
   */
  readonly errorSink?: ErrorSink
}
```

替换为：

```ts
export interface EventBusOptions {
  readonly lagSink: LagSink
  /**
   * 订阅者 handler 抛出异常时调用，用于记录可观测日志。
   * 必填：禁止 bus 在失败路径上默默走 console，所有调用方必须显式指定可观测出口。
   * 不得 rethrow，异常隔离是 bus 的核心不变量。
   */
  readonly errorSink: ErrorSink
}
```

- [ ] Modify `packages/shared/src/bus/bus.ts:92-102`:

找到：

```ts
  const defaultErrorSink: ErrorSink = ({ subscriberName, subscriptionId, envelope, error }) => {
    console.error('[EventBus] handler 抛出异常', {
      subscriberName,
      subscriptionId,
      eventId: envelope.eventId,
      eventType: envelope.type,
      error,
    })
  }

  const errorSink = options.errorSink ?? defaultErrorSink
```

替换为：

```ts
  const errorSink = options.errorSink
```

- [ ] 在 `createEventBus` 函数体开头加入运行时守卫，确保运行时调用者也无法绕过（某些下游通过 `any` 注入 options 的场景）：

找到 lines 50-52：

```ts
export function createEventBus(options: EventBusOptions): EventBus {
  const subscribers = new Map<number, Subscriber>()
  let nextId = 1
```

替换为：

```ts
export function createEventBus(options: EventBusOptions): EventBus {
  if (typeof options.errorSink !== 'function') {
    throw new TypeError('createEventBus: errorSink is required')
  }
  if (typeof options.lagSink !== 'function') {
    throw new TypeError('createEventBus: lagSink is required')
  }
  const subscribers = new Map<number, Subscriber>()
  let nextId = 1
```

### Step 3.4 — 清理已有测试中旧 defaultErrorSink 的断言

- [ ] Run:

```bash
cd /workspaces/dev_docker/tianji-ai && grep -rn "defaultErrorSink\|'\\[EventBus\\]" --include="*.ts" packages apps
```

Expected: 仅命中本 task 新测试（若命中其他测试文件，按每个命中点手动更新断言以覆盖新实现 —— 具体更新是"把断言 `console.error` 改为断言 errorSink 被显式调用"）。

### Step 3.5 — 验证

- [ ] Run:

```bash
cd /workspaces/dev_docker/tianji-ai/packages/shared && pnpm test
```

Expected: 全部 PASS。

- [ ] Run:

```bash
cd /workspaces/dev_docker/tianji-ai && pnpm check
```

Expected: 退出码 0。若 server.ts 或 daemon-entry.ts 编译期未传 errorSink 则会在这里炸出，先回到 Step 3.1 补齐。

### Step 3.6 — Commit

先加载 git-commit skill。

- [ ] Commit:

```bash
cd /workspaces/dev_docker/tianji-ai && \
git add packages/shared/src/bus/bus.ts \
        packages/shared/src/__tests__/ && \
git commit -m "refactor(shared): createEventBus 的 errorSink 改为必填"
```

---

## Task 4: controlplane 顶层崩溃防线

**Files:**
- Modify: `apps/controlplane/src/server.ts:33-136`
- Create: `apps/controlplane/src/__tests__/server-shutdown.test.ts`

### Step 4.1 — 写失败测试（shutdown 超时与 crash handler）

因 `server.ts` 当前是**模块顶层 side-effect** 形式（一 import 即启动 HTTP server），测试不便。本 task 顺带把启动逻辑封装成可导出的 `startControlPlaneServer()` + 顶层的 `if (isMain)` 调用，参考 `apps/node/src/daemon-entry.ts:424-450` 的形状。

- [ ] Create `apps/controlplane/src/__tests__/server-shutdown.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * server-shutdown 针对顶层崩溃防线的回归测试：
 * 1. uncaughtException 发生时日志写入 stack
 * 2. shutdown 链条内某步骤超时时，进程仍然会强制退出（exit 被调用）
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('control plane shutdown hardening', () => {
  it('exports startControlPlaneServer and returns a shutdown handle', async () => {
    const mod = await import('../server-entry.js')
    expect(typeof mod.startControlPlaneServer).toBe('function')
  })

  it('invokes shutdown once for uncaughtException with stack in log data', async () => {
    const mod = await import('../server-entry.js')
    const logs: Array<{ level: string; data: Record<string, unknown> | undefined }> = []

    const fakeLogger = {
      fatal: vi.fn(async (_scope, _msg, data) => {
        logs.push({ level: 'fatal', data })
      }),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      log: vi.fn(),
      child: vi.fn(),
    }

    const handle = mod.createCrashHandlers({
      logger: fakeLogger as unknown as Parameters<typeof mod.createCrashHandlers>[0]['logger'],
      shutdown: vi.fn(async () => undefined),
    })

    const err = new Error('boom')
    await handle.onUncaughtException(err)
    await handle.flush()

    expect(fakeLogger.fatal).toHaveBeenCalledTimes(1)
    const data = logs[0]?.data as Record<string, unknown> | undefined
    expect(data).toMatchObject({
      error: expect.objectContaining({
        name: 'Error',
        message: 'boom',
        stack: expect.any(String),
      }),
    })
  })

  it('forces exit when shutdown exceeds timeout', async () => {
    vi.useFakeTimers()
    const mod = await import('../server-entry.js')
    const exitSpy = vi.fn()

    const slowShutdown = vi.fn(() => new Promise<void>(() => undefined)) // 永不 resolve
    const handle = mod.createCrashHandlers({
      logger: {
        fatal: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        log: vi.fn(),
        child: vi.fn(),
      } as unknown as Parameters<typeof mod.createCrashHandlers>[0]['logger'],
      shutdown: slowShutdown,
      shutdownTimeoutMs: 1_000,
      exit: exitSpy,
    })

    const p = handle.onUncaughtException(new Error('stuck'))
    await vi.advanceTimersByTimeAsync(1_500)
    await p

    expect(slowShutdown).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(1)

    vi.useRealTimers()
  })
})
```

- [ ] Run, expect FAIL:

```bash
cd /workspaces/dev_docker/tianji-ai/apps/controlplane && pnpm test server-shutdown
```

Expected: `Cannot find module '../server-entry.js'`.

### Step 4.2 — 把 server.ts 的启动逻辑拆到 server-entry.ts

拆分动机：模块顶层 side-effect 不可测；把 I/O 封装进 `startControlPlaneServer()`，保留原 `server.ts` 作为可执行入口（`if (isMain)` 模式）。

- [ ] Create `apps/controlplane/src/server-entry.ts`（把 `server.ts` 当前 lines 1-136 的全部逻辑搬过来，改成函数式装配）:

```ts
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { serve } from '@hono/node-server'
import {
  createJsonlFileSink,
  createObserverLogger,
  createStderrSink,
  createStdoutSink,
  errorToLogData,
  type ObserverLogger,
  subscribeEventBusLogger,
  subscribeOtelAdapter,
} from '@tianji/observer'
import {
  CausalContext,
  SequenceCounter,
  createAlsCausalContextProvider,
  createRuntimeEventPipeline,
} from '@tianji/runtime'
import { createEventBus } from '@tianji/shared'

import { createApp } from './app.js'
import { createDatabase } from './db/index.js'
import { createEventLogRecoverer } from './storage/event-log-recoverer.js'
import { SqliteEventLogStore } from './storage/event-log-sqlite.js'
import { subscribeEventLog } from './storage/event-log-subscriber.js'

const SCOPE_SERVER = ['controlplane', 'server'] as const
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

export interface ControlPlaneServerHandle {
  readonly shutdown: () => Promise<void>
  readonly logger: ObserverLogger
}

/** 启动 controlplane。返回优雅关闭钩子。 */
export function startControlPlaneServer(): ControlPlaneServerHandle {
  const port = Number(process.env.TIANJI_CP_PORT ?? 3000)
  const host = process.env.TIANJI_CP_HOST ?? '0.0.0.0'
  const dataDir =
    process.env.TIANJI_CP_DATA_DIR ?? `${process.env.HOME}/.config/tianji-ai/controlplane`
  const dbPath = `${dataDir}/controlplane.db`
  const logFilePath = join(homedir(), '.config', 'tianji-ai', 'logs', 'tianji.log')

  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(homedir(), '.config', 'tianji-ai', 'logs'), { recursive: true })

  const db = createDatabase(dbPath)
  const logger = createObserverLogger({
    sinks: [
      createJsonlFileSink({ filePath: logFilePath }),
      createStdoutSink({ pretty: true }),
      createStderrSink({ minLevel: 'warn' }),
    ],
  })

  const store = new SqliteEventLogStore(db.raw)
  const recoverer = createEventLogRecoverer(store)
  const bus = createEventBus({
    lagSink: (info) => {
      void logger.warn(SCOPE_SERVER, 'cp subscriber lag', { info })
    },
    errorSink: (err) => {
      void logger.error(SCOPE_SERVER, 'cp bus subscriber error', {
        subscriberName: err.subscriberName,
        subscriptionId: err.subscriptionId,
        eventId: err.envelope.eventId,
        eventType: err.envelope.type,
        error: errorToLogData(err.error),
      })
    },
  })
  const counter = new SequenceCounter()

  const als = new AsyncLocalStorage<{ current: CausalContext }>()
  const contextProvider = createAlsCausalContextProvider(als)

  function enterCorrelation<T>(correlationId: string, fn: () => Promise<T>): Promise<T> {
    return als.run({ current: CausalContext.root(correlationId) }, fn)
  }

  const pipeline = createRuntimeEventPipeline({
    publish: (env) => bus.publish(env),
    counter,
    contextProvider,
    source: { processKind: 'cp', processId: process.pid.toString() },
    recoverer,
  })
  const eventLogHandle = subscribeEventLog(bus, store, {
    logger,
    errorSink: (err) => {
      void logger.error(SCOPE_SERVER, 'cp event-log-subscriber error', {
        subscriberName: err.subscriberName,
        subscriptionId: err.subscriptionId,
        eventId: err.envelope.eventId,
        eventType: err.envelope.type,
        error: errorToLogData(err.error),
      })
    },
  })

  subscribeEventBusLogger(bus, logger)
  subscribeOtelAdapter(bus)

  const { app, monitor } = createApp(db, logger, {
    emitEvent: (ev) => pipeline.emitEvent(ev),
    enterCorrelation,
    bus,
  })
  monitor.start()

  const server = serve({ fetch: app.fetch, port, hostname: host })

  void logger.info(SCOPE_SERVER, 'Control plane started', { port, host, dbPath })

  const shutdown = async (): Promise<void> => {
    monitor.stop()
    await bus.close()
    await eventLogHandle.close()
    db.close()
    server.close()
  }

  return { shutdown, logger }
}

/** 给崩溃 handler 的依赖注入形状。便于测试。 */
export interface CrashHandlerOptions {
  readonly logger: ObserverLogger
  readonly shutdown: () => Promise<void>
  readonly shutdownTimeoutMs?: number
  readonly exit?: (code: number) => void
}

export interface CrashHandlers {
  readonly onUncaughtException: (err: unknown) => Promise<void>
  readonly onUnhandledRejection: (err: unknown) => Promise<void>
  readonly onSignal: (signal: NodeJS.Signals) => Promise<void>
  /** 测试用：等待所有已入队的异步日志落盘。 */
  readonly flush: () => Promise<void>
}

/** 构建进程级崩溃/退出 handler。不直接注册到 process 上，便于注入与测试。 */
export function createCrashHandlers(options: CrashHandlerOptions): CrashHandlers {
  const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const exit = options.exit ?? ((code) => process.exit(code))
  const pending = new Set<Promise<unknown>>()

  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p)
    void p.finally(() => pending.delete(p))
    return p
  }

  const runShutdownWithTimeout = async (): Promise<void> => {
    await Promise.race([
      options.shutdown().catch((shutdownErr) => {
        void options.logger.error(SCOPE_SERVER, 'Shutdown step threw', {
          error: errorToLogData(shutdownErr),
        })
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => resolve(), timeoutMs)
      }),
    ])
  }

  const onUncaughtException = async (err: unknown): Promise<void> => {
    await track(
      options.logger.fatal(SCOPE_SERVER, 'Control plane crashed with uncaught exception', {
        error: errorToLogData(err),
      })
    )
    await runShutdownWithTimeout()
    exit(1)
  }

  const onUnhandledRejection = async (err: unknown): Promise<void> => {
    await track(
      options.logger.error(SCOPE_SERVER, 'Control plane caught unhandled rejection', {
        error: errorToLogData(err),
      })
    )
  }

  const onSignal = async (signal: NodeJS.Signals): Promise<void> => {
    await track(
      options.logger.info(SCOPE_SERVER, 'Control plane shutdown signal received', { signal })
    )
    await runShutdownWithTimeout()
    exit(0)
  }

  const flush = async (): Promise<void> => {
    await Promise.all([...pending])
  }

  return { onUncaughtException, onUnhandledRejection, onSignal, flush }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  try {
    const handle = startControlPlaneServer()
    const handlers = createCrashHandlers({
      logger: handle.logger,
      shutdown: handle.shutdown,
    })
    process.on('SIGTERM', (signal) => {
      void handlers.onSignal(signal)
    })
    process.on('SIGINT', (signal) => {
      void handlers.onSignal(signal)
    })
    process.on('uncaughtException', (err) => {
      void handlers.onUncaughtException(err)
    })
    process.on('unhandledRejection', (err) => {
      void handlers.onUnhandledRejection(err)
    })
  } catch (error: unknown) {
    process.stderr.write(
      `[controlplane] Fatal startup error: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    )
    if (error instanceof Error && error.stack !== undefined) {
      process.stderr.write(`${error.stack}\n`)
    }
    process.exit(1)
  }
}
```

### Step 4.3 — 让原 `server.ts` 只做转发

- [ ] Replace file `apps/controlplane/src/server.ts` with:

```ts
/**
 * controlplane 进程入口。实际装配逻辑见 `server-entry.ts`，
 * 此文件仅保留 package.json `start` 指向的路径稳定。
 */

import './server-entry.js'
```

### Step 4.4 — 跑测试

- [ ] Run:

```bash
cd /workspaces/dev_docker/tianji-ai/apps/controlplane && pnpm test server-shutdown
```

Expected: 3 个 case 全部 PASS。

- [ ] Run完整包测试:

```bash
cd /workspaces/dev_docker/tianji-ai/apps/controlplane && pnpm test
```

Expected: 全部 PASS；若有依赖 `server.ts` 副作用的老测试失败，改为 import `server-entry.js` 的具名导出。

### Step 4.5 — 全局 check

- [ ] Run:

```bash
cd /workspaces/dev_docker/tianji-ai && pnpm check
```

Expected: 退出码 0。

### Step 4.6 — 手动冒烟验证（可选但强烈建议）

- [ ] 终端 A: 启动 controlplane

```bash
cd /workspaces/dev_docker/tianji-ai && node apps/controlplane/dist/server.js 2>&1 | tee /tmp/cp-stderr.log
```

- [ ] 终端 B: 触发一次模拟崩溃（用 node 的 `--eval` 给已跑的进程发 SIGINT，或在代码里临时 `throw new Error('smoke')`，验证 stderr 能看到 fatal 记录后再回滚临时改动）。

Expected: `/tmp/cp-stderr.log` 包含一行 pretty 格式 + 一行 fatal JSON，`~/.config/tianji-ai/logs/tianji.log` 包含 fatal JSON 含 stack。

### Step 4.7 — Commit

先加载 git-commit skill。

- [ ] Commit:

```bash
cd /workspaces/dev_docker/tianji-ai && \
git add apps/controlplane/src/server.ts \
        apps/controlplane/src/server-entry.ts \
        apps/controlplane/src/__tests__/server-shutdown.test.ts && \
git commit -m "feat(controlplane): 新增 uncaughtException/unhandledRejection handler 并给 shutdown 加超时"
```

---

## Self-Review Checklist（在执行前再核对一遍）

1. **Spec 覆盖**：
   - 新 stderr 出口 → Task 2 ✅
   - Error 归一化含 stack/cause → Task 1 ✅
   - bus 默认 errorSink 删除 → Task 3 ✅
   - controlplane 崩溃防线 + shutdown 超时 → Task 4 ✅
   - node/agent 消费侧迁移 → **显式留到下一份 plan**（在 Scope Caveat 中声明）
2. **Placeholder**：无 TBD / "similar to" / "implement later"。所有代码块都给完整实现。
3. **类型一致性**：
   - `ObserverLogLevel` 与 `LOG_LEVEL_ORDER` 均来自 `types.ts` 的同一来源 ✅
   - `errorToLogData` 签名 `(err: unknown, options?: ErrorToLogDataOptions) => Record<string, unknown>` 在 Task 1 定义，在 Task 4 一致使用 ✅
   - `EventBusOptions.errorSink` 在 Task 3 由可选改必填，Task 4 中 `server-entry.ts` 调用方显式传入 ✅
   - `createCrashHandlers` 的 `logger` 参数类型为 `ObserverLogger`（Task 1/2 已导出）✅
4. **测试前置**：每个 Task 的实现前都有一条"写失败测试 → 跑 → 看见失败"步骤 ✅

---

**下一步提示：**
本 plan 完成 merge 后，再开启 `2026-04-17-unified-logging-migration.md`（尚未编写）：
- `apps/node/src/logger.ts` 切到 observer sink 组合
- `daemon-entry.ts` 顶层 handler 切到 `errorToLogData` + fatal 级
- `connection-loop.ts` 的 bare catch / `.catch(() => {})` 清理
- 16 处 `.message : String` 模式批量替换
- `packages/agent/src/acp-entry.ts` 的 `console.error` 迁移
- `apps/node/src/bin.ts` / `apps/node/src/commands/run.ts` 清理自造 sink
