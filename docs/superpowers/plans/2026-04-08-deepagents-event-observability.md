# Deep Agent 全量事件可观测性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 捕获 LangGraph 内置工具的 `on_tool_start`/`on_tool_end` 事件，映射为已有 `tool.started`/`tool.completed`/`tool.failed`，并在 runtime 层接入 observer 日志和 OpenTelemetry span。

**Architecture:** 在 deepagents-engine.ts 事件循环新增 `on_tool_start`/`on_tool_end` 处理，通过 ToolCatalog 名字判断区分内置工具和外部工具以去重。runtime.ts 的 `emitEvent` 回调增加 `logToolEvent` observer 日志和 per-run `toolSpans` Map 管理 OpenTelemetry span。

**Tech Stack:** TypeScript, LangGraph streamEvents v2, @tianji/observer (ObserverLogger, startToolSpan), Vitest

**去重方案说明：** 设计文档原定基于 `emittedToolCallIds` Set + `run_id` 去重，但实际 LangGraph streamEvents v2 中 `on_tool_start` 的 `run_id`（LangGraph 内部分配）与 `executeDeepagentsToolCall` 中的 `toolCallId`（来自 LLM tool_call_id）不同，且 `on_tool_start` 的时序先于 `executeDeepagentsToolCall`（因为 LangGraph 先 yield 事件再调用 tool func），导致 Set 去重时 Set 中永远没有匹配记录。改用 `ToolCatalog.hasTool()` 判断：外部工具（在 ToolCatalog 中注册的）由 `executeDeepagentsToolCall` 处理，内置工具（不在 ToolCatalog 中）由事件循环中的新分支处理。

---

## 涉及文件总览

| 文件 | 改动类型 | 职责 |
|------|----------|------|
| `apps/node/src/task/task-executor.ts:214-243` | Modify | 前置清理：tool.failed 日志级别改 error，删除 serializeRuntimeEvent |
| `apps/node/src/task/__tests__/task-executor.test.ts` | Modify | 新增 tool.failed error 级别日志验证测试 |
| `packages/runtime/src/engines/deepagents-engine.ts:182-216` | Modify | 事件循环扩展，on_tool_start/on_tool_end → tool.started/tool.completed；新增 builtinToolCallIds Map 跟踪 start/end 关联 |
| `packages/runtime/src/runtime.ts:580,669-707,732-753` | Modify | HITL warn→info；emitEvent 回调接入 logToolEvent 和 toolSpans；新增 logToolEvent 方法 |
| `packages/runtime/src/__tests__/runtime.test.ts` | Modify | 新增 observer logger 记录 tool 事件的验证测试 |

---

### Task 1: 前置清理 — task-executor 日志修复

**Files:**
- Modify: `apps/node/src/task/task-executor.ts:214-221,241-243`
- Modify: `apps/node/src/task/__tests__/task-executor.test.ts`

- [ ] **Step 1: 写 tool.failed 使用 error 级别日志的失败测试**

在 `apps/node/src/task/__tests__/task-executor.test.ts` 的 `describe('TaskExecutorConfig')` 末尾新增测试用例。需要先确认文件顶部已有 `import { createCliLogger } from '../../logger.js'`，若没有则添加。

```typescript
it('logs tool.failed events with error level and failure message', async () => {
  const module = await import('../task-executor.js')
  const written: Array<{ level: string; message: string; data?: Record<string, unknown> }> = []
  const logger = createCliLogger({
    sink: {
      async write(entry) {
        written.push({
          level: entry.level,
          message: entry.message,
          data: entry.data,
        })
      },
    },
  })

  const executor = new module.TaskExecutor({
    nodeId: createNodeId('node-001'),
    onExecutionStateChange: () => undefined,
    logger,
    createRunner: async () => ({
      agentId: 'default',
      connect: async () => undefined,
      disconnect: async () => undefined,
      async *query() {
        yield {
          type: 'run.started' as const,
          runId: 'run-fail' as never,
          sessionId: 'session-fail' as never,
          triggerType: 'new' as const,
          timestamp: Date.now(),
        }
        yield {
          type: 'tool.failed' as const,
          runId: 'run-fail' as never,
          toolCallId: 'tc-fail-001',
          invocation: { toolCallId: 'tc-fail-001', toolName: 'broken_tool', args: {} },
          error: { code: 'TOOL_EXECUTION_FAILED', message: 'something broke' },
          timestamp: Date.now(),
        }
        yield {
          type: 'run.completed' as const,
          runId: 'run-fail' as never,
          sessionId: 'session-fail' as never,
          triggerType: 'new' as const,
          timestamp: Date.now(),
        }
      },
    }),
    openEventStream: async () => ({
      write: async () => undefined,
      writeKeepalive: async () => undefined,
      close: async () => undefined,
      abort: () => undefined,
    }),
  })

  await executor.execute(createCommand(createTaskId('task-fail'), 'trigger failure'))

  const toolFailedLog = written.find((entry) => entry.message === 'Tool call failed')
  expect(toolFailedLog).toBeDefined()
  expect(toolFailedLog?.level).toBe('error')
  expect(toolFailedLog?.data?.toolCallId).toBe('tc-fail-001')
  expect(toolFailedLog?.data?.errorCode).toBe('TOOL_EXECUTION_FAILED')

  const wrongLevelLog = written.find(
    (entry) => entry.level === 'info' && entry.message === 'Tool call failed'
  )
  expect(wrongLevelLog).toBeUndefined()
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd /workspaces/dev_docker/tianji-ai/apps/node && pnpm vitest run src/task/__tests__/task-executor.test.ts`
Expected: FAIL — 当前 tool.failed 使用 `logInfo` 且消息为 "Tool call completed"

- [ ] **Step 3: 修复 task-executor.ts 的 handleEvent 函数**

在 `apps/node/src/task/task-executor.ts` 中修改 `handleEvent` 函数（第 214-221 行）。

将：
```typescript
  } else if (event.type === 'tool.completed' || event.type === 'tool.failed') {
    turn.toolCallCount += 1
    void logger?.logInfo(scope, 'Tool call completed', {
      taskId,
      runId: event.runId,
      toolCallId: event.toolCallId,
      toolCall: extractToolCallLabel(event),
    })
```

替换为：
```typescript
  } else if (event.type === 'tool.completed') {
    turn.toolCallCount += 1
    void logger?.logInfo(scope, 'Tool call completed', {
      taskId,
      runId: event.runId,
      toolCallId: event.toolCallId,
      toolCall: extractToolCallLabel(event),
    })
  } else if (event.type === 'tool.failed') {
    turn.toolCallCount += 1
    void logger?.logError(scope, 'Tool call failed', {
      taskId,
      runId: event.runId,
      toolCallId: event.toolCallId,
      toolCall: extractToolCallLabel(event),
      errorCode: event.error.code,
      errorMessage: event.error.message,
    })
```

- [ ] **Step 4: 删除 serializeRuntimeEvent identity function**

在 `apps/node/src/task/task-executor.ts` 中：

1. 将第 115 行的 `event: serializeRuntimeEvent(event)` 改为 `event`
2. 删除第 241-243 行的 `serializeRuntimeEvent` 函数

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd /workspaces/dev_docker/tianji-ai/apps/node && pnpm vitest run src/task/__tests__/task-executor.test.ts`
Expected: ALL PASS

- [ ] **Step 6: 运行 pnpm check**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/node/src/task/task-executor.ts apps/node/src/task/__tests__/task-executor.test.ts
git commit -m "fix(task-executor): use error level for tool.failed logs, remove identity serializer"
```

---

### Task 2: deepagents-engine 事件循环扩展

**Files:**
- Modify: `packages/runtime/src/engines/deepagents-engine.ts:126-246,344-361,372-481`

- [ ] **Step 1: 在事件循环中添加 builtinToolCallIds Map 和 on_tool_start/on_tool_end 处理**

在 `packages/runtime/src/engines/deepagents-engine.ts` 的 `executeDeepagentsRun` 函数中：

第一处：在 `let finalMessage: AppMessage | undefined` 之后（第 148 行附近）添加：

```typescript
  /** 跟踪内置工具的 toolCallId，用于关联 on_tool_start 和 on_tool_end。key: 工具名队列 */
  const builtinToolCallQueue = new Map<string, string[]>()
```

第二处：在事件循环中，`isLangGraphChainEnd` 检查块之后、循环 `}` 之前（第 215 行之后）添加：

```typescript

    // 捕获 LangGraph 内置工具事件。
    // 外部工具（ToolCatalog 中注册的）由 executeDeepagentsToolCall 处理，此处跳过。
    if (event.event === 'on_tool_start') {
      if (!options.toolCatalog.hasTool(event.name)) {
        const toolCallId = `builtin_tool_${randomUUID()}`
        const queue = builtinToolCallQueue.get(event.name) ?? []
        queue.push(toolCallId)
        builtinToolCallQueue.set(event.name, queue)

        options.emitEvent({
          type: 'tool.started',
          runId: options.runId,
          toolCallId,
          invocation: {
            toolCallId,
            toolName: event.name,
            args: (event.data?.input ?? {}) as Record<string, unknown>,
          },
          timestamp: Date.now(),
        })
      }
      continue
    }

    if (event.event === 'on_tool_end') {
      if (!options.toolCatalog.hasTool(event.name)) {
        const queue = builtinToolCallQueue.get(event.name)
        const toolCallId = queue?.shift() ?? `builtin_tool_${randomUUID()}`
        if (queue !== undefined && queue.length === 0) {
          builtinToolCallQueue.delete(event.name)
        }

        options.emitEvent({
          type: 'tool.completed',
          runId: options.runId,
          toolCallId,
          result: {
            toolCallId,
            result: event.data?.output,
          },
          timestamp: Date.now(),
        })
      }
      continue
    }
```

- [ ] **Step 2: 运行 pnpm check 确认类型正确**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/runtime/src/engines/deepagents-engine.ts
git commit -m "feat(deepagents-engine): capture on_tool_start/on_tool_end for builtin tools"
```

---

### Task 3: runtime.ts — observer logger 接入

**Files:**
- Modify: `packages/runtime/src/runtime.ts:525-667,669-707,732-753`
- Modify: `packages/runtime/src/__tests__/runtime.test.ts`

- [ ] **Step 1: 写 observer logger 记录 tool 事件的测试**

在 `packages/runtime/src/__tests__/runtime.test.ts` 中新增测试。先阅读该文件了解现有测试模式，然后在合适的 describe 块中添加：

```typescript
it('logs tool events to observer logger', async () => {
  const sink = createMemorySink()
  const logger = createObserverLogger({ sinks: [sink] })

  const runtime = createSessionRuntime({
    deepagents: {
      model: fakeModel().respondWithTools([
        { name: 'greet', args: { name: 'world' }, id: 'tool-log' },
      ]),
    },
    logger,
    toolCatalog: new ToolRegistry().registerTool({
      spec: {
        name: 'greet',
        description: 'Greet someone',
        parameters: { type: 'object' },
      },
      execute: async () => 'hello world',
      sideEffect: 'none',
    }),
  })

  const session = await runtime.createSession()
  const runId = await runtime.runTurn({
    sessionId: session.sessionId,
    message: createUserMessage('msg-log', 'greet'),
  })
  await collectRuntimeEvents(runId, runtime)

  const toolLogs = sink.entries.filter(
    (entry) =>
      entry.message === 'tool.started' || entry.message === 'tool.completed'
  )
  expect(toolLogs.length).toBeGreaterThanOrEqual(2)
  expect(toolLogs.find((e) => e.message === 'tool.started')).toBeDefined()
  expect(toolLogs.find((e) => e.message === 'tool.completed')).toBeDefined()
})
```

需要确认文件顶部已导入 `createMemorySink`、`createObserverLogger`、`fakeModel`、`createUserMessage`、`collectRuntimeEvents`、`ToolRegistry`。

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && pnpm vitest run src/__tests__/runtime.test.ts`
Expected: FAIL — 当前 emitEvent 回调不写 observer logger

- [ ] **Step 3: 在 runtime.ts 中新增 logToolEvent 方法**

在 `packages/runtime/src/runtime.ts` 的 `SessionRuntimeImpl` 类中，在 `logRunLifecycle` 方法之后（第 753 行之后），新增 `logToolEvent` 方法。

需要先在文件顶部添加导入：
```typescript
import type { ToolStartedEvent, ToolCompletedEvent, ToolFailedEvent } from '@tianji/shared'
```

确认 `@tianji/shared` 的导入中是否已有这些类型。当前导入（第 18-32 行）：
```typescript
import {
  type AppMessage,
  CancelledError,
  ...
  type RuntimeEvent,
  ...
} from '@tianji/shared'
```

需要在此导入中添加 `type ToolStartedEvent, type ToolCompletedEvent, type ToolFailedEvent`。

新增方法：

```typescript
  /**
   * 将工具事件写入 observer logger，scope 为 ['runtime', 'tool']。
   * runtime 层记录所有 session 的工具事件，与 TaskExecutor 层的单任务摘要日志互补。
   */
  private logToolEvent(
    event: ToolStartedEvent | ToolCompletedEvent | ToolFailedEvent,
    fields: RunLineageFields
  ): void {
    const logger = this.options.logger

    if (logger === undefined) {
      return
    }

    if (event.type === 'tool.started') {
      void logger.info(['runtime', 'tool'], 'tool.started', {
        sessionId: fields.sessionId,
        runId: fields.runId,
        toolCallId: event.toolCallId,
        toolName: event.invocation.toolName,
      })
    } else if (event.type === 'tool.completed') {
      void logger.info(['runtime', 'tool'], 'tool.completed', {
        sessionId: fields.sessionId,
        runId: fields.runId,
        toolCallId: event.toolCallId,
      })
    } else {
      void logger.error(['runtime', 'tool'], 'tool.failed', {
        sessionId: fields.sessionId,
        runId: fields.runId,
        toolCallId: event.toolCallId,
        errorCode: event.error.code,
      })
    }
  }
```

- [ ] **Step 4: 修改 executeDeepagentsTurn 中的 emitEvent 回调**

在 `packages/runtime/src/runtime.ts` 的 `executeDeepagentsTurn` 方法中（第 705 行），将 `emitEvent` 从：

```typescript
      emitEvent: (event) => activeRun.events.push(event),
```

改为：

```typescript
      emitEvent: (event) => {
        activeRun.events.push(event)
        if (
          event.type === 'tool.started' ||
          event.type === 'tool.completed' ||
          event.type === 'tool.failed'
        ) {
          this.logToolEvent(
            event as ToolStartedEvent | ToolCompletedEvent | ToolFailedEvent,
            lineage
          )
        }
      },
```

注意：`lineage` 变量需要在 `executeDeepagentsTurn` 中可用。当前 `executeDeepagentsTurn` 没有 `lineage`。需要从 `activeRun` 构造。

在 `executeDeepagentsTurn` 方法开头添加 lineage 构造：

```typescript
    const lineage = createRunLineageFields({
      sessionId: activeRun.sessionId,
      runId: activeRun.runId,
      triggerType: input.triggerType,
      parentRunId: input.parentRunId,
    })
```

- [ ] **Step 5: 修复 HITL 中断日志级别 warn → info**

在 `packages/runtime/src/runtime.ts` 第 580 行，将：

```typescript
        this.logRunLifecycle('warn', 'run.cancelled', lineage)
```

改为：

```typescript
        this.logRunLifecycle('info', 'run.cancelled', lineage)
```

注意：只修改 HITL 中断路径（第 580 行），不修改 catch 块中的取消路径（第 636 行），因为后者是外部中断，保留 warn 级别是合理的。

- [ ] **Step 6: 运行测试，确认通过**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && pnpm vitest run src/__tests__/runtime.test.ts`
Expected: PASS

- [ ] **Step 7: 运行 pnpm check**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/runtime/src/runtime.ts packages/runtime/src/__tests__/runtime.test.ts
git commit -m "feat(runtime): add observer logger for tool events, fix HITL log level"
```

---

### Task 4: runtime.ts — OpenTelemetry span 接入

**Files:**
- Modify: `packages/runtime/src/runtime.ts:17,669-707`

- [ ] **Step 1: 添加 startToolSpan 导入**

在 `packages/runtime/src/runtime.ts` 文件顶部，将：

```typescript
import type { ObserverLogger } from '@tianji/observer'
```

改为：

```typescript
import { startToolSpan, type ObserverLogger, type ObserverStartedSpan } from '@tianji/observer'
```

- [ ] **Step 2: 在 executeDeepagentsTurn 中添加 per-run toolSpans Map**

在 `executeDeepagentsTurn` 方法中，`lineage` 变量之后（Task 3 Step 4 中添加的），添加：

```typescript
    /** per-run 工具 span 跟踪，run 结束后闭包释放自动 GC */
    const toolSpans = new Map<string, ObserverStartedSpan>()
```

- [ ] **Step 3: 在 emitEvent 回调中添加 span 管理逻辑**

将 Task 3 Step 4 中修改的 emitEvent 回调扩展为：

```typescript
      emitEvent: (event) => {
        activeRun.events.push(event)
        if (
          event.type === 'tool.started' ||
          event.type === 'tool.completed' ||
          event.type === 'tool.failed'
        ) {
          this.logToolEvent(
            event as ToolStartedEvent | ToolCompletedEvent | ToolFailedEvent,
            lineage
          )
        }
        if (event.type === 'tool.started') {
          const span = startToolSpan({
            toolName: (event as ToolStartedEvent).invocation.toolName,
            runId: event.runId,
          })
          if (span !== undefined) {
            toolSpans.set((event as ToolStartedEvent).toolCallId, span)
          }
        }
        if (event.type === 'tool.completed' || event.type === 'tool.failed') {
          const toolCallId = (event as ToolCompletedEvent | ToolFailedEvent).toolCallId
          const span = toolSpans.get(toolCallId)
          if (span !== undefined) {
            span.end()
            toolSpans.delete(toolCallId)
          }
        }
      },
```

- [ ] **Step 4: 运行 pnpm check**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: PASS

- [ ] **Step 5: 运行 runtime 全部测试确保无回归**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && pnpm vitest run`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/runtime.ts
git commit -m "feat(runtime): integrate OpenTelemetry tool spans in emitEvent callback"
```

---

### Task 5: 集成验证

- [ ] **Step 1: 运行 runtime 包全部测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && pnpm vitest run`
Expected: ALL PASS

- [ ] **Step 2: 运行 node app 全部测试**

Run: `cd /workspaces/dev_docker/tianji-ai/apps/node && pnpm vitest run`
Expected: ALL PASS

- [ ] **Step 3: 运行全局 pnpm check**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: PASS，无类型错误、无 lint 错误

- [ ] **Step 4: 如有失败，修复后重新验证**

---

## 验收标准对照

| 验收标准 | 对应 Task |
|----------|-----------|
| agent 执行内置工具后 TaskExecutor 日志中 `toolCallCount >= 1` | Task 2（事件循环扩展） |
| observer JSONL 日志中出现 `tool.started` 和 `tool.completed` | Task 3（logToolEvent） |
| 外部工具不产生重复事件 | Task 2（hasTool 判断跳过外部工具） |
| `tool.failed` 为 error 级别，消息为 "Tool call failed" | Task 1（前置清理） |
| `pnpm check` 通过 | Task 5（集成验证） |
