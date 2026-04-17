# Unified Logging Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `2026-04-17-unified-logging-foundation.md` 打下来的 observer 合流管道真正接入每一个日志调用点，让 `err.message : String(err)` 模式、ACP 入口的 `console.error`、自造 JSONL 写盘和自造 error-formatter 全部归并到 observer 出口，同时把 daemon 顶层崩溃升级为 `fatal` 级结构化日志。

**Architecture:** 迁移分 5 层：

1. **Node 侧 CliLogger**（apps/node/src/logger.ts）把 sinks 换成 observer 的 `createJsonlFileSink` + `createStderrSink({ minLevel: 'warn' })`，删除内联 `mkdir/appendFile`。
2. **Daemon 顶层崩溃**（apps/node/src/daemon-entry.ts）用 `errorToLogData` 替代 `formatErrorMessage`、`uncaughtException` 用 `fatal` 级、顶层启动 fallback 用结构化日志。
3. **Controlplane 业务日志**（event-log-subscriber / routes/events / observation-monitor / server-entry startup fallback）用 `errorToLogData` 替代 `.message : String()`。
4. **Packages/agent 的 ACP 入口**（acp-entry / agent-bridge / session）用 observer logger + `createStderrSink` 替代 `console.error`、`.message : String()`。
5. **自造 errorformatter 归并**（connection-loop 的本地 `toErrorLogData`、node-runtime/controlplane-runtime 的 fire-and-forget 链）统一用 `errorToLogData`。

**Tech Stack:** TypeScript（strict，无 `any`）、Vitest（含 fake timers / vi.spyOn）、pnpm monorepo、@tianji/observer（`createJsonlFileSink` / `createStderrSink` / `createStdoutSink` / `errorToLogData` 已在 foundation 阶段落地）。

**前置阅读：**

- `docs/superpowers/plans/2026-04-17-unified-logging-foundation.md`（4 个 Task 已完成，提供 `errorToLogData`、`createStderrSink`、`createEventBus.errorSink` 必填、controlplane 崩溃防线）
- `packages/observer/src/logger/error-formatter.ts`（`errorToLogData` 契约：归一化 `{name, message, stack, cause, ...}`，深度可控，敏感键透传）
- `packages/observer/src/logger/sinks/file-jsonl.ts`、`stderr.ts`、`stdout.ts`（sink 构造器）
- `apps/controlplane/src/server-entry.ts`（作为 observer 合流 + 顶层 crash handler 的参考样板）

**范围边界：**

- **不触碰**：`apps/node/src/bin.ts`、`apps/node/src/main.ts:formatCliError`、`apps/controlplane/src/routes/copilot.ts:108`——这些是面向用户的 CLI 文案或非日志的错误消息比对。
- **不触碰**：`packages/runtime/src/llm-call-recorder.ts:48`——这是把 LLM 错误序列化进 domain 记录，不是日志。
- **不触碰**：`packages/observer/src/logger/error-formatter.ts:55`——`errorToLogData` 自身的 stack-getter 防御。
- **测试文件**：跨包 `.message : String` 模式在 foundation 的 Task 3 已批量处理，这里不再替换测试里的日志格式化。

---

## Scope Check

Plan 覆盖 4 个包（apps/node, apps/controlplane, packages/agent, packages/runtime — runtime 只读验证），所有任务都围绕同一主题"把日志现场归并到 observer 出口"，每个 Task 聚焦一个独立的文件或子系统，且每个 Task 完成后产物可独立部署运行、`pnpm check` 绿。不拆成多 plan。

## File Structure

| 文件 | 责任变化 |
| --- | --- |
| `apps/node/src/logger.ts` | `createCliLoggerFromPaths` 改用 observer 的 `createJsonlFileSink` + `createStderrSink({ minLevel: 'warn' })`，删除内联 `mkdir/appendFile` 路径。`CliLogger` 接口不变。 |
| `apps/node/src/daemon-entry.ts` | 删除 `formatErrorMessage`；bus errorSink、顶层 `uncaughtException/unhandledRejection` handler、启动 fallback 全部用 `errorToLogData`；`uncaughtException` 记 `fatal` 级。 |
| `apps/node/src/controlplane/connection-loop.ts` | 删除本地 `toErrorLogData`；调用点改用 `errorToLogData`。 |
| `apps/node/src/node-runtime/controlplane-runtime.ts` | 三处 `.message : String(error)` → `...errorToLogData(error)`；末端 `.catch(() => {})` 保留并加一句注释说明目的。 |
| `apps/controlplane/src/storage/event-log-subscriber.ts` | 两处 `err instanceof Error ? err.message : String(err)` → `errorToLogData(err)` 展开。 |
| `apps/controlplane/src/routes/events.ts` | 一处同样替换。 |
| `apps/controlplane/src/services/observation-monitor.ts` | `emitSafe` 内部一处替换。 |
| `apps/controlplane/src/server-entry.ts` | 启动 fallback 的 stderr 字符串拼接改为：stderr fallback + 通过 observer logger 追加 `fatal` 级结构化落盘。 |
| `packages/agent/src/acp-entry.ts` | 构造 observer logger（sinks: `createJsonlFileSink` + `createStderrSink({ pretty: true })`），替换 5 处 `console.error`；致命错用 `fatal` + `errorToLogData`；把 logger 传入 `TianjiAcpAgent`。 |
| `packages/agent/src/acp/agent-bridge.ts` | 构造函数新增可选 `logger: ObserverLogger`，7 处 `console.error` 改为 `logger?.debug/info/error`。 |
| `packages/agent/src/session.ts` | 两处 `err instanceof Error ? err.message : String(err)` → `errorToLogData(err)`。 |

## 约定

- 所有 Task 完成后必须运行 `pnpm check`（仓库根），退出码 0。
- 每个 Task 单独 commit；commit message 按现仓惯例（`feat(scope): ...` / `refactor(scope): ...`）。
- TDD 顺序：失败测试 → 验证失败 → 实现 → 验证通过 → 提交。日志调用点若已被上游测试覆盖（例如 daemon e2e），只需新增结构化 assert（断言 data.stack 存在），不需要新建文件。

---

### Task 1: Node CliLogger 改用 observer sinks 合流

**Files:**

- Modify: `apps/node/src/logger.ts:162-171`（`createCliLoggerFromPaths`）
- Test: `apps/node/src/__tests__/logger.test.ts`（新建；若已存在则追加 describe 块）

**背景：** 当前 `createCliLoggerFromPaths` 内联了 `mkdir/appendFile`；foundation 已经提供 `createJsonlFileSink(filePath)`，功能等价。再叠加一个 `createStderrSink({ minLevel: 'warn' })` 让 warn/error 在 CLI 前台可见（文件始终留痕）。

- [ ] **Step 1: 写失败测试（logger 会写文件 + warn 级同时进 stderr，debug 级不进 stderr）**

在 `apps/node/src/__tests__/logger.test.ts` 新增：

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UserConfigPaths } from '../config.js'
import { getCliLogger } from '../logger.js'

describe('getCliLogger sinks', () => {
  let tmpRoot: string
  let paths: UserConfigPaths
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'tianji-cli-log-'))
    paths = {
      logsDir: join(tmpRoot, 'logs'),
      cliLogFilePath: join(tmpRoot, 'logs', 'cli.jsonl'),
    } as UserConfigPaths
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    stderrSpy.mockRestore()
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('writes jsonl file for all levels and stderr only for warn/error', async () => {
    const cli = getCliLogger(paths)
    await cli.logDebug(['cli', 'test'], 'debug-msg')
    await cli.logWarn(['cli', 'test'], 'warn-msg')
    await cli.logError(['cli', 'test'], 'error-msg', { detail: 'boom' })

    const fileContent = await readFile(paths.cliLogFilePath, 'utf8')
    const lines = fileContent.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.level)).toEqual(['debug', 'warn', 'error'])

    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).not.toContain('debug-msg')
    expect(stderrOutput).toContain('warn-msg')
    expect(stderrOutput).toContain('error-msg')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/node && pnpm test -- logger.test.ts`
Expected: FAIL — 当前 logger 没挂 stderr sink，stderr 不会有任何输出。

- [ ] **Step 3: 改 `createCliLoggerFromPaths` 用 observer sinks**

修改 `apps/node/src/logger.ts`：

```ts
import type {
  ObserverLogEntry,
  ObserverLogLevel,
  ObserverLogScope,
  ObserverLogSink,
  ObserverLogger,
} from '@tianji/observer'
import {
  createJsonlFileSink,
  createObserverLogger,
  createStderrSink,
} from '@tianji/observer'

import type { UserConfigPaths } from './config.js'
```

把 `createCliLoggerFromPaths` 改成：

```ts
function createCliLoggerFromPaths(paths: UserConfigPaths): CliLogger {
  const fileSink = createJsonlFileSink({ filePath: paths.cliLogFilePath })
  const stderrSink = createStderrSink({ minLevel: 'warn' })
  return createCliLoggerWithSinks(paths, [fileSink, stderrSink])
}

function createCliLoggerWithSinks(
  paths: UserConfigPaths,
  sinks: readonly ObserverLogSink[]
): CliLogger {
  const observerLogger = createObserverLogger({
    sinks,
    sensitiveKeys: ['prompt', 'soul'],
  })
  const primarySink = sinks[0]
  return {
    observerLogger,
    appendCliLog(entry) {
      return primarySink !== undefined ? primarySink.write(entry) : Promise.resolve()
    },
    logDebug(scope, message, data) {
      return observerLogger.debug(scope, message, data)
    },
    logInfo(scope, message, data) {
      return observerLogger.info(scope, message, data)
    },
    logWarn(scope, message, data) {
      return observerLogger.warn(scope, message, data)
    },
    logError(scope, message, data) {
      return observerLogger.error(scope, message, data)
    },
  }
}
```

`createCliLogger` 的签名 `{ sink: ObserverLogSink }` 保留（保持调用方兼容），但实现改为 `return createCliLoggerWithSinks(paths, [options.sink])`；若不需要给单 sink 构造器留口子，可整段删除并把调用点改成 `createCliLoggerWithSinks`——在提交前先 `grep -r 'createCliLogger(' apps packages` 确认无外部调用者，确认无调用则删除。

删除文件顶部残留的 `import { appendFile, mkdir }`（不再使用）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/node && pnpm test -- logger.test.ts`
Expected: PASS

Run: `cd apps/node && pnpm test`
Expected: 所有原有 node 包测试通过（没有回归）。

- [ ] **Step 5: 仓库级检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add apps/node/src/logger.ts apps/node/src/__tests__/logger.test.ts
git commit -m "refactor(node): route CliLogger through observer file + stderr sinks"
```

---

### Task 2: Daemon 顶层崩溃用 fatal + errorToLogData

**Files:**

- Modify: `apps/node/src/daemon-entry.ts:40-43`（删除 `formatErrorMessage`）
- Modify: `apps/node/src/daemon-entry.ts:64-72`（bus errorSink 用 `errorToLogData`）
- Modify: `apps/node/src/daemon-entry.ts:350-365`（controlplane connect failure 用 `errorToLogData`）
- Modify: `apps/node/src/daemon-entry.ts:381-402`（shutdown `uncaughtException` 路径升级为 fatal）
- Modify: `apps/node/src/daemon-entry.ts:414-421`（unhandledRejection 用 `errorToLogData`）
- Modify: `apps/node/src/daemon-entry.ts:428-449`（顶层启动 fallback 用 `errorToLogData`）
- Test: `apps/node/src/__tests__/daemon-entry-crash.test.ts`（新建）

**背景：** 当前所有顶层崩溃只记 `error.message`，foundation 的 `errorToLogData` 可把 stack/cause 展开并脱敏。同时 `uncaughtException` 是真正意义上的致命错，应该进 `fatal` 级；stderr sink 的 `minLevel: 'warn'` 会让 fatal 自动到前台。

- [ ] **Step 1: 写失败测试（模拟 uncaughtException，断言 logger.fatal 被调用且 data 含 stack）**

在 `apps/node/src/__tests__/daemon-entry-crash.test.ts` 新建：

```ts
import { describe, expect, it, vi } from 'vitest'

import { buildDaemonCrashLogData } from '../daemon-entry.js'

describe('buildDaemonCrashLogData', () => {
  it('includes stack and cause for Error objects', () => {
    const cause = new Error('inner')
    const error = new Error('outer', { cause })
    const data = buildDaemonCrashLogData(error)

    expect(data).toMatchObject({
      name: 'Error',
      message: 'outer',
    })
    expect(typeof data.stack).toBe('string')
    expect(data.stack).toContain('outer')
    expect(data.cause).toMatchObject({ name: 'Error', message: 'inner' })
  })

  it('falls back to string coercion for non-Error throws', () => {
    const data = buildDaemonCrashLogData('boom')
    expect(data).toMatchObject({ message: 'boom' })
  })
})
```

注：`buildDaemonCrashLogData` 是 Step 3 要新增的内部 helper（薄包装 `errorToLogData` 以便单元化）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/node && pnpm test -- daemon-entry-crash.test.ts`
Expected: FAIL — 函数未导出。

- [ ] **Step 3: 实现**

在 `apps/node/src/daemon-entry.ts` 顶部 import:

```ts
import { errorToLogData } from '@tianji/observer'
```

删除 `formatErrorMessage` 函数（第 41-43 行）。

新增并导出：

```ts
/** 把 daemon 顶层抛出物规范化为结构化日志 data（保留 stack/cause）。 */
export function buildDaemonCrashLogData(error: unknown): Record<string, unknown> {
  return errorToLogData(error)
}
```

替换第 64-72 行（bus errorSink）：

```ts
    errorSink: (err) => {
      void logger.observerLogger.error(['daemon', 'bus'], 'daemon bus subscriber error', {
        subscriberName: err.subscriberName,
        subscriptionId: err.subscriptionId,
        eventId: err.envelope.eventId,
        eventType: err.envelope.type,
        ...errorToLogData(err.error),
      })
    },
```

替换第 351-362 行（controlplane connect failure）：

```ts
    } catch (error) {
      const errorData = errorToLogData(error)
      updateControlPlaneStatus({
        enabled: true,
        status: 'degraded',
        baseUrl: controlPlaneConfig.baseUrl,
        lastError: typeof errorData.message === 'string' ? errorData.message : String(error),
      })
      await logError(context.paths, ['daemon', 'controlplane'], 'Control plane connection failed', {
        baseUrl: controlPlaneConfig.baseUrl,
        nodeId: controlPlaneConfig.nodeId,
        ...errorData,
      })
      // controlplane 连接失败时 daemon 继续以本地模式运行
      process.stderr.write('Warning: controlplane connection failed, running in local-only mode\n')
    }
```

替换第 382-386 行（shutdown 的 uncaughtException 分支，改为 fatal 级 + 结构化）：

```ts
      if (reason.type === 'uncaughtException') {
        await logger.observerLogger.fatal(
          ['daemon'],
          'Daemon crashed with uncaught exception',
          buildDaemonCrashLogData(reason.error)
        )
      }
```

注：要用 `logger.observerLogger.fatal`，因为 `CliLogger` 没有 `logFatal` 包装器——保持 YAGNI，不给 CliLogger 接口加一个只用一次的方法。

替换第 417-421 行（unhandledRejection handler）：

```ts
  process.on('unhandledRejection', (error) => {
    void logger.observerLogger.error(
      ['daemon'],
      'Daemon caught unhandled rejection',
      buildDaemonCrashLogData(error)
    )
  })
```

替换第 431-447 行（顶层启动 fallback）：

```ts
  } catch (error) {
    const data = buildDaemonCrashLogData(error)
    const message = typeof data.message === 'string' ? data.message : String(error)
    process.stderr.write(`[daemon] Fatal startup error: ${message}\n`)
    if (typeof data.stack === 'string') {
      process.stderr.write(`${data.stack}\n`)
    }
    try {
      const { getUserConfigPaths } = await import('./config.js')
      const paths = getUserConfigPaths()
      await logError(paths, ['daemon'], 'Fatal startup error', data)
    } catch {
      // 日志写入失败时不再尝试（该分支本身已是最后兜底）
    }
    process.exit(1)
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/node && pnpm test -- daemon-entry-crash.test.ts`
Expected: PASS（两条用例全绿）。

Run: `cd apps/node && pnpm test`
Expected: 所有原有测试通过；如果 `daemon-e2e.test.ts` 里有对日志 message 的严格字符串匹配，放宽为断言 `data.message` + 存在 `data.stack` 字段。

- [ ] **Step 5: 仓库级检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add apps/node/src/daemon-entry.ts apps/node/src/__tests__/daemon-entry-crash.test.ts
git commit -m "feat(daemon): upgrade top-level crashes to fatal + errorToLogData"
```

---

### Task 3: Controlplane 业务日志归并

**Files:**

- Modify: `apps/controlplane/src/storage/event-log-subscriber.ts:57-77, 85-105`（`onFlushError` + committer push catch）
- Modify: `apps/controlplane/src/routes/events.ts:65-75`（ingest catch）
- Modify: `apps/controlplane/src/services/observation-monitor.ts:10-24`（`emitSafe`）
- Modify: `apps/controlplane/src/server-entry.ts:259-268`（启动 fallback 的 stderr 拼接）
- Test: `apps/controlplane/src/storage/__tests__/event-log-subscriber.test.ts`（扩一条断言）

**背景：** 这四个现场都在 `.message : String()` 吞 stack。替换后在问题排查时可直接从 JSONL 拿到完整调用栈。不触碰 `routes/copilot.ts:108`——那里用 `/not found/i.test(message)` 做错误分类，不是日志。

- [ ] **Step 1: 放宽/新增测试断言 data.stack 存在**

在 `apps/controlplane/src/storage/__tests__/event-log-subscriber.test.ts` 里找已有的 flush-failure 测试，补断言（若没有现成 flush-error case 则新增）：

```ts
it('logs flush failures with structured error data including stack', async () => {
  const logEntries: Array<{ level: string; data?: Record<string, unknown> }> = []
  const logger = {
    error: (_scope: unknown, _msg: unknown, data?: Record<string, unknown>) => {
      logEntries.push({ level: 'error', data })
      return Promise.resolve()
    },
    // 其它方法按需加 stub
  }
  // ... 触发 flush 抛错的既有逻辑 ...
  const flushLog = logEntries.find((l) => l.data?.itemCount !== undefined)
  expect(flushLog?.data?.stack).toEqual(expect.any(String))
  expect(flushLog?.data?.name).toBe('Error')
})
```

若该文件已有等价的"验证 error 日志被发出"用例，直接在原断言基础上追加 `expect(...data.stack).toEqual(expect.any(String))`。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/controlplane && pnpm test -- event-log-subscriber.test.ts`
Expected: FAIL — 当前 log data 只有 `error: string`，没有 `stack`。

- [ ] **Step 3: 实现**

**`apps/controlplane/src/storage/event-log-subscriber.ts`:**

顶部 import 追加：

```ts
import { errorToLogData } from '@tianji/observer'
```

替换 `onFlushError`（第 57-68 行区域）中的 `error: err instanceof Error ? err.message : String(err)`：

```ts
      void logger?.error(['event-log-subscriber', 'flush'], 'batch flush failed', {
        itemCount: items.length,
        ...errorToLogData(err),
        ...diagnostics,
      })
```

替换 push catch 分支（第 87-95 行）：

```ts
        void logger?.error(
          ['event-log-subscriber', 'push'],
          'failed to push envelope to committer',
          {
            eventId: env.eventId,
            ...errorToLogData(err),
          }
        )
```

**`apps/controlplane/src/routes/events.ts`:**

顶部 import 追加 `errorToLogData`。替换第 68-73 行：

```ts
        void logger.error(['cp', 'ingest'], 'ingest rejected envelope', {
          eventId: env.eventId,
          eventType: env.type,
          processKind: env.source.processKind,
          ...errorToLogData(err),
        })
```

**`apps/controlplane/src/services/observation-monitor.ts`:**

顶部 import 追加 `errorToLogData`。替换 `emitSafe`（第 17-22 行）：

```ts
    result.catch((err: unknown) => {
      void logger.error(SCOPE_MONITOR, 'emitEvent failed', {
        eventType: event.type,
        ...errorToLogData(err),
      })
    })
```

**`apps/controlplane/src/server-entry.ts`（启动 fallback）：**

把第 259-268 行改成：

```ts
  } catch (error: unknown) {
    const data = errorToLogData(error)
    const message = typeof data.message === 'string' ? data.message : String(error)
    process.stderr.write(`[controlplane] Fatal startup error: ${message}\n`)
    if (typeof data.stack === 'string') {
      process.stderr.write(`${data.stack}\n`)
    }
    process.exit(1)
  }
```

（确认顶部已 import `errorToLogData`；foundation 阶段已注入。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/controlplane && pnpm test`
Expected: 所有用例通过（原 199 + 1 新增/扩展）。

- [ ] **Step 5: 仓库级检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add apps/controlplane/src/storage/event-log-subscriber.ts \
        apps/controlplane/src/routes/events.ts \
        apps/controlplane/src/services/observation-monitor.ts \
        apps/controlplane/src/server-entry.ts \
        apps/controlplane/src/storage/__tests__/event-log-subscriber.test.ts
git commit -m "refactor(controlplane): route service logs through errorToLogData"
```

---

### Task 4: Packages/agent 的 ACP 入口迁移到 observer 日志

**Files:**

- Modify: `packages/agent/src/acp-entry.ts`（整体重写日志出口；5 处 `console.error` + 致命 catch）
- Modify: `packages/agent/src/acp/agent-bridge.ts`（构造函数接受可选 logger；7 处 `console.error` 替换）
- Modify: `packages/agent/src/session.ts:155, 255`（`.message : String` → `errorToLogData`）
- Test: `packages/agent/src/acp/__tests__/agent-bridge.test.ts`（新增 logger 注入用例）

**背景：** ACP 子进程中 stdout 被 JSON-RPC 独占，stderr 是允许的日志通道。foundation 的 `createStderrSink({ pretty: true })` 语义契合。session 里的 `.message : String` 是 emitEvent fire-and-forget catch，换 errorToLogData 保留 stack。

- [ ] **Step 1: 写失败测试（agent-bridge 构造函数可以注入 logger，关键路径调用 logger.error）**

在 `packages/agent/src/acp/__tests__/agent-bridge.test.ts`（或新建）追加：

```ts
import { describe, expect, it, vi } from 'vitest'

import { TianjiAcpAgent } from '../agent-bridge.js'

describe('TianjiAcpAgent logger injection', () => {
  it('accepts a logger and routes cancel to debug level', async () => {
    const logger = {
      debug: vi.fn().mockResolvedValue(undefined),
      info: vi.fn().mockResolvedValue(undefined),
      warn: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
      fatal: vi.fn().mockResolvedValue(undefined),
      trace: vi.fn().mockResolvedValue(undefined),
      log: vi.fn().mockResolvedValue(undefined),
      child: vi.fn().mockReturnThis(),
    }
    const fakeConnection = { sessionUpdate: vi.fn() }
    const fakeEntry = {
      run: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
      stream: vi.fn(),
    }
    const agent = new TianjiAcpAgent(fakeConnection as never, fakeEntry as never, { logger })
    await agent.cancel({ sessionId: 'unused' } as never)
    expect(logger.debug).toHaveBeenCalledWith(
      ['acp', 'bridge'],
      expect.stringContaining('cancel'),
      expect.any(Object)
    )
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/agent && pnpm test -- agent-bridge.test.ts`
Expected: FAIL — `TianjiAcpAgent` 构造函数当前只接受 `(connection, entry)`。

- [ ] **Step 3: 实现**

**`packages/agent/src/acp/agent-bridge.ts`：** 构造函数加第三个可选 options：

```ts
import type { ObserverLogger } from '@tianji/observer'

export interface TianjiAcpAgentOptions {
  readonly logger?: ObserverLogger
}

export class TianjiAcpAgent {
  readonly #connection: AgentSideConnection
  readonly #entry: UnifiedRuntimeEntry
  readonly #logger: ObserverLogger | undefined
  #currentSessionId: string | null = null
  #abortController: AbortController | null = null

  constructor(
    connection: AgentSideConnection,
    entry: UnifiedRuntimeEntry,
    options: TianjiAcpAgentOptions = {}
  ) {
    this.#connection = connection
    this.#entry = entry
    this.#logger = options.logger
  }
```

把 7 处 `console.error` 替换（scope 统一用 `['acp', 'bridge']`）：

- `initialize` 行 43：`void this.#logger?.debug(['acp', 'bridge'], 'received initialize request')`
- `newSession` 行 55：`void this.#logger?.info(['acp', 'bridge'], 'new session created', { sessionId: this.#currentSessionId })`
- `prompt` 行 67：`void this.#logger?.debug(['acp', 'bridge'], 'received prompt request', { sessionId: params.sessionId })`
- 行 96 `cancelled`：`void this.#logger?.debug(['acp', 'bridge'], 'prompt cancelled', { sessionId: params.sessionId })`
- 行 107 `completed`：`void this.#logger?.debug(['acp', 'bridge'], 'prompt completed', { sessionId: params.sessionId })`
- `cancel` 行 115：`void this.#logger?.debug(['acp', 'bridge'], 'received cancel request')`

**`packages/agent/src/acp-entry.ts`：** 顶部 import：

```ts
import type { ObserverLogger } from '@tianji/observer'
import {
  createJsonlFileSink,
  createObserverLogger,
  createStderrSink,
  errorToLogData,
} from '@tianji/observer'
```

新增私有 helper：

```ts
function createAcpLogger(context: AgentContext): ObserverLogger {
  return createObserverLogger({
    sinks: [
      createJsonlFileSink({ filePath: context.paths.acpLogFilePath ?? context.paths.cliLogFilePath }),
      createStderrSink({ minLevel: 'info', pretty: true }),
    ],
  })
}
```

注：`AgentContext` 的 paths 如果没有 acp 专用文件路径，先 fallback 到 CLI 日志路径（两者都是 daemon 级 JSONL）。`createAcpLogger` 的签名 `context: AgentContext` 视 `loadAgentContext` 的返回类型决定——在 Step 3 实施时先 `grep AgentContext packages/agent/src` 确认类型。

`runAcpAgent` 主体改写：

```ts
export async function runAcpAgent(): Promise<void> {
  const context = await loadAgentContext()
  const logger = createAcpLogger(context)
  await logger.info(['acp', 'entry'], 'acp agent starting', { agentName: context.agent.agentName })

  const built = await buildDefaultGraph(
    { source: 'acp', input: '', agentId: context.agent.agentName },
    context
  )
  const entry = createUnifiedRuntimeEntry({
    // ... 原样保留 ...
  })

  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(output, input)

  const connection = new AgentSideConnection(
    (conn) => new TianjiAcpAgent(conn, entry, { logger }),
    stream
  )

  await logger.info(['acp', 'entry'], 'acp connection established')
  await connection.closed
  await logger.info(['acp', 'entry'], 'acp connection closed')
}
```

`if (isMain)` 分支的致命 catch：

```ts
if (isMain) {
  try {
    await runAcpAgent()
  } catch (error: unknown) {
    const data = errorToLogData(error)
    process.stderr.write(`[acp-agent] Fatal: ${data.message ?? String(error)}\n`)
    if (typeof data.stack === 'string') {
      process.stderr.write(`${data.stack}\n`)
    }
    process.exit(1)
  }
}
```

**`packages/agent/src/session.ts`：** 顶部 import 追加：

```ts
import { errorToLogData } from '@tianji/observer'
```

替换第 152-157 行：

```ts
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          void options?.logger?.error(['agent', 'session'], 'SessionClosed emitEvent failed', {
            sessionId,
            ...errorToLogData(err),
          })
        })
      }
```

替换第 250-257 行（`resumeAgentSession` 内对称位置）：

```ts
        result.catch((err: unknown) => {
          void runtimeOptions?.logger?.error(
            ['agent', 'session'],
            'SessionClosed emitEvent failed',
            { sessionId, ...errorToLogData(err) }
          )
        })
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/agent && pnpm test`
Expected: 所有用例通过。注意 session 的 `.message : String` 相关断言若存在也需放宽为 `expect(data).toMatchObject({ message: ... })`。

- [ ] **Step 5: 仓库级检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/acp-entry.ts packages/agent/src/acp/agent-bridge.ts \
        packages/agent/src/session.ts packages/agent/src/acp/__tests__/agent-bridge.test.ts
git commit -m "refactor(agent): migrate acp entry and session logs to observer logger"
```

---

### Task 5: 归并自造 errorformatter 与 runtime fire-and-forget 链

**Files:**

- Modify: `apps/node/src/controlplane/connection-loop.ts:12-28`（删除 `toErrorLogData`）
- Modify: `apps/node/src/controlplane/connection-loop.ts` 所有 `toErrorLogData(...)` 调用点（改为 `errorToLogData(...)` 展开或直接传）
- Modify: `apps/node/src/node-runtime/controlplane-runtime.ts:248-290`（三处 `.message : String(error)` → `...errorToLogData(error)`；末端 `.catch(() => {})` 加注释）
- Test: `apps/node/src/controlplane/__tests__/connection-loop.test.ts`（若存在则扩断言；否则新建一条最小单测）

**背景：** `connection-loop.ts` 自造的 `toErrorLogData` 实际等价于 `errorToLogData` 的弱化版（只解一层 cause，无 stack）。把它删掉避免两套 error 规范并存。`controlplane-runtime.ts` 的 fire-and-forget 链末端 `.catch(() => {})` 是为避免 logger 内部 reject 冒泡成 unhandledRejection——这是设计，保留，但加一行注释解释。

- [ ] **Step 1: 写失败测试（connection-loop 错误落盘含 stack）**

在 `apps/node/src/controlplane/__tests__/connection-loop.test.ts` 里找已有的 error-log case（heartbeat fail / register fail），补断言：

```ts
expect(loggedError.data).toMatchObject({
  name: expect.any(String),
  message: expect.any(String),
})
expect(typeof loggedError.data?.stack).toBe('string')
```

若文件不存在，写最小测试：

```ts
import { describe, expect, it, vi } from 'vitest'

import { ControlPlaneConnection } from '../connection-loop.js'

describe('ControlPlaneConnection error logging', () => {
  it('logs heartbeat failures with stack data', async () => {
    const errorLogs: Array<{ scope: readonly string[]; data?: Record<string, unknown> }> = []
    const logger = {
      logDebug: vi.fn().mockResolvedValue(undefined),
      logInfo: vi.fn().mockResolvedValue(undefined),
      logWarn: vi.fn().mockResolvedValue(undefined),
      logError: vi.fn((scope, _msg, data) => {
        errorLogs.push({ scope, data })
        return Promise.resolve()
      }),
    }
    // 构造一个会失败的 ControlPlaneClient stub，触发心跳失败路径。
    // 此处调用连接启动并等待第一次心跳失败被日志记录。
    // ...（按现有 connection-loop 测试框架写入最小 reproduce）

    const heartbeat = errorLogs.find((l) => l.scope.includes('heartbeat'))
    expect(heartbeat?.data).toMatchObject({ name: expect.any(String) })
    expect(typeof heartbeat?.data?.stack).toBe('string')
  })
})
```

（实现这段 stub 的具体代码取决于 connection-loop 现有的测试脚手架；若没有，请先读 `connection-loop.ts` 内 `start()` 的心跳循环，构造一个 `ControlPlaneClient` mock 使 `heartbeat()` reject。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/node && pnpm test -- connection-loop.test.ts`
Expected: FAIL — 当前 `toErrorLogData` 只写 `{ error, errorName, errorCause }`，没有 `stack` / `name`。

- [ ] **Step 3: 实现**

**`apps/node/src/controlplane/connection-loop.ts`：**

- 删除 12-28 行的 `function toErrorLogData`。
- 顶部 import 追加：

  ```ts
  import { errorToLogData } from '@tianji/observer'
  ```

- 所有调用点 `toErrorLogData(error)` 改为 `errorToLogData(error)`；如果上游希望把 error 作为整个 data 对象而不是合并（即原来是 `data = toErrorLogData(err)`），直接改为 `data = errorToLogData(err)` 即可——类型兼容。

（`errorToLogData` 默认键是 `name/message/stack/cause`；原来 `toErrorLogData` 用 `errorName/errorCause`。如果现有 logger 消费方断言 `errorName`，改为 `name`；旧断言同步更新。此处应先 `grep 'errorName' apps/node/src` 确认无外部消费者再决定。）

**`apps/node/src/node-runtime/controlplane-runtime.ts`：**

顶部 import 追加 `errorToLogData`。

替换第 250-259 行：

```ts
        taskExecutorRef
          .execute(taskCommand)
          .catch((error) => {
            // fire-and-forget：日志 Promise reject 也不能冒泡，否则变成 unhandledRejection。
            config.logger
              ?.logError(['daemon', 'controlplane'], 'Failed to execute task command', {
                commandId: taskCommand.commandId,
                taskId: taskCommand.payload.taskId,
                agentId: taskCommand.payload.agentId,
                ...errorToLogData(error),
              })
              ?.catch(() => {})
          })
```

替换第 269-278 行（`task.cancel` 分支）：

```ts
        try {
          registry.cancel(String(command.payload.taskId))
        } catch (error) {
          // fire-and-forget：同上，防止日志 reject 冒泡。
          config.logger
            ?.logError(['daemon', 'controlplane'], 'Failed to cancel task', {
              commandId: command.commandId,
              taskId: command.payload.taskId,
              ...errorToLogData(error),
            })
            ?.catch(() => {})
        }
```

第 280-290 行（unsupported command）保留逻辑但加同款注释，不需要 `errorToLogData`（没有错误对象）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/node && pnpm test`
Expected: 所有用例通过。

- [ ] **Step 5: 仓库级检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add apps/node/src/controlplane/connection-loop.ts \
        apps/node/src/node-runtime/controlplane-runtime.ts \
        apps/node/src/controlplane/__tests__/connection-loop.test.ts
git commit -m "refactor(node): consolidate error log data through errorToLogData"
```

---

## Self-Review

**Spec coverage**（foundation 计划 + 用户"还有哪些残留"清单 → 是否每项都映射到 Task）：

- `apps/node/src/logger.ts` 自造 sink → **Task 1** ✅
- `daemon-entry.ts` 顶层 handler → **Task 2** ✅
- `connection-loop.ts` bare catch / 本地 `toErrorLogData` → **Task 5** ✅
- 全仓 `.message : String(err)` 批量替换 → 分摊到 **Task 2 / 3 / 4 / 5**（以业务现场为粒度，不做一次性 grep-replace）✅
- `packages/agent/src/acp-entry.ts` 的 `console.error` → **Task 4** ✅
- `apps/node/src/bin.ts` / `commands/run.ts` 清理自造 sink → **故意不处理**：bin.ts 是 CLI 顶层 fallback，main.ts 的 `formatCliError` 是面向用户文案，非结构化日志。在 plan 开头的"范围边界"段落已声明。✅

**Placeholder 扫描**：无 "TBD"、"add appropriate..."、"similar to Task N" 等 filler。Task 4 Step 3 的 `createAcpLogger` 对 `context.paths.acpLogFilePath` 的 fallback 给出了具体 grep 提示；Task 5 Step 1 的测试模板指示了"若没有现成脚手架请先读 connection-loop"——属于"判断分支"而非 placeholder。

**类型一致性**：

- `errorToLogData` 返回 `Record<string, unknown>`，各 Task 都按展开（`...errorToLogData(err)`）或作为完整 data 对象传递。
- `TianjiAcpAgent` 构造函数新增 `options?: TianjiAcpAgentOptions`——签名向后兼容。
- `connection-loop.ts` 的 `errorName/errorCause` 消费者若存在，Step 3 明确要求先 grep 再改，避免键名漂移。
- `CliLogger` 接口保持 4 级公共 API（debug/info/warn/error），`fatal` 在 daemon 顶层直接经 `logger.observerLogger.fatal` 调用，不强行扩 CliLogger API。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-17-unified-logging-migration.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每 Task 派遣 fresh sonnet implementer，opus 做 spec review + code quality review，快速迭代。
2. **Inline Execution** — 在当前会话里按 `superpowers:executing-plans` 批量推进，含 checkpoint。

需要哪种方式？
