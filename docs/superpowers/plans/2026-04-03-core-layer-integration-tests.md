# Agent + Runtime 核心层集成测试实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 runtime + agent 引擎层建立系统化集成测试套件，覆盖多轮对话、工具策略、并发、错误恢复、checkpoint 恢复与快照一致性。

**Architecture:** 增强现有 `runtime-test-utils.ts` 添加 mock 工具/断言工具函数，新建 `suite/` 子目录按场景分文件。Agent 层新建 `agent-test-utils.ts` 提供不依赖文件系统的测试上下文。所有测试使用 `FakeListChatModel` / `fakeModel()` 进程内替身，不引入 Mock HTTP 服务器。

**Tech Stack:** Vitest, `@langchain/core/testing` (fakeModel, FakeListChatModel), `@langchain/langgraph` (MemorySaver), `@tianji/shared`, `@tianji/runtime`

---

## 文件结构

| 操作 | 文件路径 | 职责 |
|------|----------|------|
| 修改 | `packages/runtime/src/__tests__/helpers/runtime-test-utils.ts` | 新增 createMockTool, createToolRegistry, driveMultiTurn, waitForEvent, createFakeModel, assertRunCompleted, assertRunFailed, assertToolCalled, assertToolFailed |
| 新建 | `packages/runtime/src/__tests__/suite/multi-turn.test.ts` | 多轮对话连续性测试 |
| 新建 | `packages/runtime/src/__tests__/suite/tool-policy.test.ts` | 工具执行策略测试 |
| 新建 | `packages/runtime/src/__tests__/suite/concurrency.test.ts` | 并发安全测试 |
| 新建 | `packages/runtime/src/__tests__/suite/error-recovery.test.ts` | 错误恢复与降级测试 |
| 新建 | `packages/runtime/src/__tests__/suite/checkpoint-resume.test.ts` | Checkpoint + HITL 恢复测试 |
| 新建 | `packages/runtime/src/__tests__/suite/snapshot-consistency.test.ts` | 快照一致性测试 |
| 新建 | `packages/agent/src/__tests__/helpers/agent-test-utils.ts` | Agent 测试上下文构造 |
| 新建 | `packages/agent/src/__tests__/suite/session-e2e.test.ts` | Agent Session 端到端测试 |

---

## Task 1: 增强 runtime-test-utils.ts

**Files:**
- Modify: `packages/runtime/src/__tests__/helpers/runtime-test-utils.ts`
- Test: 新增工具函数通过后续 suite 测试间接验证

- [ ] **Step 1: 阅读现有 runtime-test-utils.ts**

确认现有导出：`createRuntimeHarness`, `createDeferred`, `createAbortError`, `collectRuntimeEvents`, `collectRuntimeOutcome`, `collectRuntimeEventsWithAggregation`, `createUserMessage`, `readTextContent`, `waitForRunStatus`。

- [ ] **Step 2: 添加 MockToolOptions 类型和 createMockTool 函数**

在文件末尾追加：

```typescript
export interface MockToolOptions {
  readonly sideEffect?: RuntimeToolSideEffect
  readonly result?: unknown
  readonly error?: Error
  readonly delayMs?: number
}

/**
 * 快速构造 RuntimeToolDefinition。
 * @param name - 工具名
 * @param opts - 可选配置
 */
export function createMockTool(
  name: string,
  opts?: MockToolOptions
): RuntimeToolDefinition {
  return {
    spec: {
      name,
      description: `Mock tool: ${name}`,
      parameters: { type: 'object' },
    },
    sideEffect: opts?.sideEffect ?? 'none',
    execute: async () => {
      if (opts?.delayMs !== undefined && opts.delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, opts.delayMs)
        })
      }

      if (opts?.error !== undefined) {
        throw opts.error
      }

      return opts?.result ?? 'ok'
    },
  }
}
```

需要新增 import：

```typescript
import { type RuntimeToolDefinition, type RuntimeToolSideEffect, ToolRegistry } from '../../tool-catalog.js'
```

注意：现有文件已导入 `ToolCatalog` 和 `ToolRegistry`，需要补充 `RuntimeToolDefinition` 和 `RuntimeToolSideEffect`。

- [ ] **Step 3: 添加 createToolRegistry 函数**

```typescript
/**
 * 批量注册工具并返回 ToolRegistry。
 */
export function createToolRegistry(
  ...tools: RuntimeToolDefinition[]
): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of tools) {
    registry.registerTool(tool)
  }
  return registry
}
```

- [ ] **Step 4: 添加 createFakeModel 函数**

需要新增 import：

```typescript
import { FakeListChatModel } from '@langchain/core/utils/testing'
```

```typescript
/**
 * 封装 FakeListChatModel 创建。
 */
export function createFakeModel(responses: string[]): FakeListChatModel {
  return new FakeListChatModel({ responses })
}
```

- [ ] **Step 5: 添加 driveMultiTurn 函数**

```typescript
/**
 * 顺序执行多轮 runTurn，返回每轮的事件集合。
 * 每轮等待 run 完成后再发起下一轮。
 */
export async function driveMultiTurn(
  runtime: SessionRuntime,
  sessionId: SessionId,
  prompts: Array<{ id: string; text: string }>,
  options?: { systemPrompt?: string }
): Promise<Array<{ runId: RunId; events: RuntimeEvent[] }>> {
  const results: Array<{ runId: RunId; events: RuntimeEvent[] }> = []

  for (const prompt of prompts) {
    const runId = await runtime.runTurn({
      sessionId,
      message: createUserMessage(prompt.id, prompt.text),
      systemPrompt: options?.systemPrompt,
    })
    const events = await collectRuntimeEvents(runId, runtime)
    results.push({ runId, events })
  }

  return results
}
```

需要新增 import `SessionId` from `@tianji/shared`。

- [ ] **Step 6: 添加 waitForEvent 函数**

```typescript
/**
 * 等待事件流中出现特定类型的事件，超时报错。
 */
export async function waitForEvent(
  runtime: SessionRuntime,
  runId: RunId,
  eventType: RuntimeEvent['type'],
  timeoutMs = 2000
): Promise<RuntimeEvent> {
  const deadline = Date.now() + timeoutMs

  for await (const event of runtime.streamEvents(runId)) {
    if (event.type === eventType) {
      return event
    }

    if (Date.now() > deadline) {
      break
    }
  }

  throw new Error(`Timed out waiting for event "${eventType}" on run "${runId}"`)
}
```

- [ ] **Step 7: 添加断言辅助函数**

```typescript
/**
 * 断言事件序列包含 run.completed 且不含 run.failed。
 */
export function assertRunCompleted(events: RuntimeEvent[]): void {
  const types = events.map((e) => e.type)
  expect(types).toContain('run.completed')
  expect(types).not.toContain('run.failed')
}

/**
 * 断言事件序列以 run.failed 结束。
 */
export function assertRunFailed(events: RuntimeEvent[], errorPattern?: RegExp): void {
  const failedEvent = events.find(
    (e): e is Extract<RuntimeEvent, { type: 'run.failed' }> => e.type === 'run.failed'
  )
  expect(failedEvent).toBeDefined()

  if (errorPattern !== undefined && failedEvent !== undefined) {
    expect(failedEvent.error.message).toMatch(errorPattern)
  }
}

/**
 * 断言特定工具被调用并完成。
 */
export function assertToolCalled(events: RuntimeEvent[], toolName: string): void {
  const toolStarted = events.find(
    (e): e is Extract<RuntimeEvent, { type: 'tool.started' }> =>
      e.type === 'tool.started' && e.invocation.toolName === toolName
  )
  const toolCompleted = events.find(
    (e): e is Extract<RuntimeEvent, { type: 'tool.completed' }> =>
      e.type === 'tool.completed' && e.toolCallId === toolStarted?.toolCallId
  )
  expect(toolStarted).toBeDefined()
  expect(toolCompleted).toBeDefined()
}

/**
 * 断言特定工具调用失败。
 */
export function assertToolFailed(events: RuntimeEvent[], toolName: string): void {
  const toolFailed = events.find(
    (e): e is Extract<RuntimeEvent, { type: 'tool.failed' }> =>
      e.type === 'tool.failed' && e.invocation.toolName === toolName
  )
  expect(toolFailed).toBeDefined()
}
```

- [ ] **Step 8: 验证编译通过**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: 无新增错误

- [ ] **Step 9: Commit**

```
feat(runtime): 增强测试工具函数支持集成测试套件
```

---

## Task 2: multi-turn.test.ts — 多轮对话连续性

**Files:**
- Create: `packages/runtime/src/__tests__/suite/multi-turn.test.ts`

- [ ] **Step 1: 编写测试文件**

```typescript
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createSessionRuntime } from '../../runtime.js'
import { InMemorySnapshotStore } from '../../snapshot-store.js'
import {
  assertRunCompleted,
  assertToolCalled,
  createMockTool,
  createToolRegistry,
  createUserMessage,
  driveMultiTurn,
  readTextContent,
} from '../helpers/runtime-test-utils.js'

describe('suite/multi-turn', () => {
  it('accumulates messages across 3 consecutive turns', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respond(new AIMessage('answer-1'))
          .respond(new AIMessage('answer-2'))
          .respond(new AIMessage('answer-3')),
      },
      snapshotStore,
      toolCatalog: createToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-multi-turn-3'),
    })

    const results = await driveMultiTurn(runtime, session.sessionId, [
      { id: 'msg-1', text: 'turn 1' },
      { id: 'msg-2', text: 'turn 2' },
      { id: 'msg-3', text: 'turn 3' },
    ])

    // 每轮 run.completed
    for (const result of results) {
      assertRunCompleted(result.events)
    }

    // 每轮 session snapshot 的 messages 数量递增（user+assistant 交替）
    for (let i = 0; i < results.length; i++) {
      const snapshot = await runtime.getSessionSnapshot(session.sessionId)
      // 最终状态：3 轮 * 2 条（user + assistant）= 6 条
      expect(snapshot?.messages).toHaveLength(6)
    }

    // 验证消息内容
    const finalSnapshot = await runtime.getSessionSnapshot(session.sessionId)
    expect(readTextContent(finalSnapshot?.messages[1])).toBe('answer-1')
    expect(readTextContent(finalSnapshot?.messages[3])).toBe('answer-2')
    expect(readTextContent(finalSnapshot?.messages[5])).toBe('answer-3')
  })

  it('includes prior turn messages in subsequent run history', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respond(new AIMessage('first'))
          .respond(new AIMessage('second')),
      },
      snapshotStore,
      toolCatalog: createToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-multi-turn-history'),
    })

    await driveMultiTurn(runtime, session.sessionId, [
      { id: 'msg-h1', text: 'hello' },
      { id: 'msg-h2', text: 'follow up' },
    ])

    // 第 2 轮的 run snapshot 应包含第 1 轮的 user + assistant 消息
    const finalSnapshot = await runtime.getSessionSnapshot(session.sessionId)
    expect(finalSnapshot?.messages).toHaveLength(4)
    expect(finalSnapshot?.messages[0]?.role).toBe('user')
    expect(finalSnapshot?.messages[1]?.role).toBe('assistant')
    expect(finalSnapshot?.messages[2]?.role).toBe('user')
    expect(finalSnapshot?.messages[3]?.role).toBe('assistant')
  })

  it('preserves tool call results in message history across turns', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'echo', args: { text: 'ping' }, id: 'tool-echo-1' }])
          .respond(new AIMessage('echo done'))
          .respond(new AIMessage('follow up answer')),
      },
      snapshotStore,
      toolCatalog: createToolRegistry(createMockTool('echo', { result: 'pong' })),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-multi-turn-tools'),
    })

    const results = await driveMultiTurn(runtime, session.sessionId, [
      { id: 'msg-t1', text: 'call echo' },
      { id: 'msg-t2', text: 'what happened?' },
    ])

    assertToolCalled(results[0]!.events, 'echo')
    assertRunCompleted(results[0]!.events)
    assertRunCompleted(results[1]!.events)

    // session 消息历史中包含工具调用
    const snapshot = await runtime.getSessionSnapshot(session.sessionId)
    expect(snapshot!.messages.length).toBeGreaterThanOrEqual(4)
  })

  it('uses same sessionId but different runIds across turns', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respond(new AIMessage('a'))
          .respond(new AIMessage('b')),
      },
      snapshotStore,
      toolCatalog: createToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-multi-turn-ids'),
    })

    const results = await driveMultiTurn(runtime, session.sessionId, [
      { id: 'msg-id1', text: 'first' },
      { id: 'msg-id2', text: 'second' },
    ])

    // sessionId 一致
    for (const result of results) {
      const startEvent = result.events.find((e) => e.type === 'run.started')
      expect(startEvent).toMatchObject({ sessionId: session.sessionId })
    }

    // runId 各不相同
    expect(results[0]!.runId).not.toBe(results[1]!.runId)
  })

  it('updates session snapshot updatedAt monotonically across turns', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respond(new AIMessage('a'))
          .respond(new AIMessage('b'))
          .respond(new AIMessage('c')),
      },
      snapshotStore,
      toolCatalog: createToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-multi-turn-timestamps'),
    })

    const timestamps: number[] = []

    for (const prompt of [
      { id: 'msg-ts1', text: '1' },
      { id: 'msg-ts2', text: '2' },
      { id: 'msg-ts3', text: '3' },
    ]) {
      const runId = await runtime.runTurn({
        sessionId: session.sessionId,
        message: createUserMessage(prompt.id, prompt.text),
      })
      // 等待 run 完成
      for await (const _event of runtime.streamEvents(runId)) {
        // consume
      }
      const snapshot = await runtime.getSessionSnapshot(session.sessionId)
      timestamps.push(snapshot!.updatedAt)
    }

    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]!)
    }
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && pnpm vitest run src/__tests__/suite/multi-turn.test.ts`
Expected: 所有用例 PASS

- [ ] **Step 3: 修复失败用例（如有）**

根据错误调整测试或发现 runtime 问题。

- [ ] **Step 4: Commit**

```
test(runtime): 添加多轮对话连续性集成测试
```

---

## Task 3: tool-policy.test.ts — 工具执行策略

**Files:**
- Create: `packages/runtime/src/__tests__/suite/tool-policy.test.ts`

- [ ] **Step 1: 编写测试文件**

```typescript
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { DEFAULT_EXECUTION_POLICY, PolicyError, ToolError, createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createSessionRuntime } from '../../runtime.js'
import { InMemorySnapshotStore } from '../../snapshot-store.js'
import { ensureToolAllowed } from '../../tool-catalog.js'
import {
  assertRunCompleted,
  assertToolCalled,
  collectRuntimeOutcome,
  createMockTool,
  createToolRegistry,
  createUserMessage,
} from '../helpers/runtime-test-utils.js'

describe('suite/tool-policy', () => {
  it('executes sideEffect=none tools normally', async () => {
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'safe', args: {}, id: 'tool-safe' }])
          .respond(new AIMessage('done')),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: createToolRegistry(createMockTool('safe', { sideEffect: 'none', result: 'ok' })),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-tool-policy-none'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-tp-none', 'call safe'),
    })
    const { events } = await collectRuntimeOutcome(runId, runtime)

    assertToolCalled(events, 'safe')
    assertRunCompleted(events)
  })

  it('executes sideEffect=idempotent tools normally', async () => {
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'idem', args: {}, id: 'tool-idem' }])
          .respond(new AIMessage('done')),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: createToolRegistry(
        createMockTool('idem', { sideEffect: 'idempotent', result: 'ok' })
      ),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-tool-policy-idempotent'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-tp-idem', 'call idem'),
    })
    const { events } = await collectRuntimeOutcome(runId, runtime)

    assertToolCalled(events, 'idem')
    assertRunCompleted(events)
  })

  it('blocks sideEffect=destructive tools when allowDestructive=false (default)', async () => {
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'danger', args: {}, id: 'tool-danger' },
        ]),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: createToolRegistry(
        createMockTool('danger', { sideEffect: 'destructive', result: 'deleted' })
      ),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-tool-policy-blocked'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-tp-blocked', 'call danger'),
    })
    const { events, error } = await collectRuntimeOutcome(runId, runtime)

    // 工具被策略拦截，run 应该失败
    expect(error).toBeDefined()
    const failedEvent = events.find((e) => e.type === 'tool.failed')
    expect(failedEvent).toBeDefined()
  })

  it('allows sideEffect=destructive tools when allowDestructive=true', async () => {
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'danger', args: {}, id: 'tool-danger-ok' }])
          .respond(new AIMessage('deleted')),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: createToolRegistry(
        createMockTool('danger', { sideEffect: 'destructive', result: 'deleted' })
      ),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-tool-policy-allowed'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-tp-allowed', 'call danger'),
      policy: {
        ...DEFAULT_EXECUTION_POLICY,
        tool: { ...DEFAULT_EXECUTION_POLICY.tool, allowDestructive: true },
      },
    })
    const { events } = await collectRuntimeOutcome(runId, runtime)

    assertToolCalled(events, 'danger')
    assertRunCompleted(events)
  })

  it('reports TOOL_NOT_FOUND for unregistered tools', async () => {
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'ghost', args: {}, id: 'tool-ghost' },
        ]),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: createToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-tool-policy-notfound'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-tp-notfound', 'call ghost'),
    })
    const { error } = await collectRuntimeOutcome(runId, runtime)

    expect(error).toBeDefined()
  })

  describe('ensureToolAllowed unit tests', () => {
    const baseTool = createMockTool('test')

    it('allows none + allowDestructive=false', () => {
      const tool = { ...baseTool, sideEffect: 'none' as const }
      expect(() => ensureToolAllowed(tool, false)).not.toThrow()
    })

    it('allows none + allowDestructive=true', () => {
      const tool = { ...baseTool, sideEffect: 'none' as const }
      expect(() => ensureToolAllowed(tool, true)).not.toThrow()
    })

    it('allows idempotent + allowDestructive=false', () => {
      const tool = { ...baseTool, sideEffect: 'idempotent' as const }
      expect(() => ensureToolAllowed(tool, false)).not.toThrow()
    })

    it('allows idempotent + allowDestructive=true', () => {
      const tool = { ...baseTool, sideEffect: 'idempotent' as const }
      expect(() => ensureToolAllowed(tool, true)).not.toThrow()
    })

    it('blocks destructive + allowDestructive=false', () => {
      const tool = { ...baseTool, sideEffect: 'destructive' as const }
      expect(() => ensureToolAllowed(tool, false)).toThrow(PolicyError)
    })

    it('allows destructive + allowDestructive=true', () => {
      const tool = { ...baseTool, sideEffect: 'destructive' as const }
      expect(() => ensureToolAllowed(tool, true)).not.toThrow()
    })
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && pnpm vitest run src/__tests__/suite/tool-policy.test.ts`
Expected: 所有用例 PASS

- [ ] **Step 3: 修复失败用例（如有）**

- [ ] **Step 4: Commit**

```
test(runtime): 添加工具执行策略集成测试
```

---

## Task 4: snapshot-consistency.test.ts — 快照一致性

**Files:**
- Create: `packages/runtime/src/__tests__/suite/snapshot-consistency.test.ts`

- [ ] **Step 1: 编写测试文件**

```typescript
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createSessionRuntime } from '../../runtime.js'
import { InMemorySnapshotStore } from '../../snapshot-store.js'
import { ToolRegistry } from '../../tool-catalog.js'
import {
  collectRuntimeEvents,
  collectRuntimeOutcome,
  createAbortError,
  createDeferred,
  createMockTool,
  createToolRegistry,
  createUserMessage,
  readTextContent,
  waitForRunStatus,
} from '../helpers/runtime-test-utils.js'

describe('suite/snapshot-consistency', () => {
  it('run completed snapshot has correct status, messages, and pendingOperations', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'calc', args: { x: 1 }, id: 'tool-calc' }])
          .respond(new AIMessage('result')),
      },
      snapshotStore,
      toolCatalog: createToolRegistry(createMockTool('calc', { result: 42 })),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-snap-completed'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-snap-c', 'calc'),
    })
    await collectRuntimeEvents(runId, runtime)

    const runSnapshot = await runtime.getRunSnapshot(runId)
    expect(runSnapshot?.status).toBe('completed')
    expect(runSnapshot?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
      ])
    )
    expect(runSnapshot?.pendingOperations).toEqual([
      expect.objectContaining({ id: 'tool-calc', status: 'completed' }),
    ])
  })

  it('run cancelled snapshot has correct status and cancelPoint', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'slow', args: {}, id: 'tool-slow' },
        ]),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry().registerTool({
        spec: { name: 'slow', description: 'Slow tool', parameters: { type: 'object' } },
        execute: async (_args, context) => {
          toolSignalSeen.resolve(context.abortSignal)
          await new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener('abort', () => {
              reject(createAbortError('cancelled'))
            }, { once: true })
          })
          throw new Error('Unreachable')
        },
        sideEffect: 'idempotent',
      }),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-snap-cancelled'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-snap-x', 'slow'),
    })
    const eventsPromise = collectRuntimeEvents(runId, runtime)
    await toolSignalSeen.promise
    runtime.cancelRun(runId)
    await eventsPromise

    const runSnapshot = await waitForRunStatus(runtime, runId, 'cancelled')
    expect(runSnapshot.status).toBe('cancelled')
    expect(runSnapshot.cancelPoint).toBeDefined()
    expect(runSnapshot.pendingOperations[0]?.status).toBe('aborted-clean')
  })

  it('run failed snapshot has status=failed and metadata.failureCode', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'boom', args: {}, id: 'tool-boom' },
        ]),
      },
      snapshotStore,
      toolCatalog: createToolRegistry(
        createMockTool('boom', { error: new Error('explosion') })
      ),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-snap-failed'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-snap-f', 'boom'),
    })
    await collectRuntimeOutcome(runId, runtime)

    const runSnapshot = await waitForRunStatus(runtime, runId, 'failed')
    expect(runSnapshot.status).toBe('failed')
    expect(runSnapshot.metadata).toHaveProperty('failureCode')
  })

  it('session snapshot has assistant message appended after run completed', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('hello')) },
      snapshotStore,
      toolCatalog: createToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-snap-session'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-snap-s', 'hi'),
    })
    await collectRuntimeEvents(runId, runtime)

    const snapshot = await runtime.getSessionSnapshot(session.sessionId)
    expect(snapshot?.messages).toHaveLength(2)
    expect(snapshot?.messages[0]?.role).toBe('user')
    expect(snapshot?.messages[1]?.role).toBe('assistant')
    expect(readTextContent(snapshot?.messages[1])).toBe('hello')
    expect(snapshot!.updatedAt).toBeGreaterThan(session.updatedAt)
  })

  it('closeSession writes closedAt in metadata', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('ok')) },
      snapshotStore,
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-snap-close'),
    })
    const closedSession = await runtime.closeSession(session.sessionId)

    expect(closedSession.metadata?.closedAt).toEqual(expect.any(Number))
  })

  it('closeSession aborts active run', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'block', args: {}, id: 'tool-block' },
        ]),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry().registerTool({
        spec: { name: 'block', description: 'Block', parameters: { type: 'object' } },
        execute: async (_args, context) => {
          toolSignalSeen.resolve(context.abortSignal)
          await new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener('abort', () => {
              reject(createAbortError('closed'))
            }, { once: true })
          })
          throw new Error('Unreachable')
        },
        sideEffect: 'idempotent',
      }),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-snap-close-active'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-snap-ca', 'block'),
    })
    const eventsPromise = collectRuntimeEvents(runId, runtime)
    await toolSignalSeen.promise

    await runtime.closeSession(session.sessionId)
    await eventsPromise

    const runSnapshot = await waitForRunStatus(runtime, runId, 'cancelled')
    expect(runSnapshot.status).toBe('cancelled')
  })

  it('closed session rejects new runTurn', async () => {
    const runtime = createSessionRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('ok')) },
      snapshotStore: new InMemorySnapshotStore(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-snap-closed-run'),
    })
    await runtime.closeSession(session.sessionId)

    await expect(
      runtime.runTurn({
        sessionId: session.sessionId,
        message: createUserMessage('msg-snap-cr', 'try'),
      })
    ).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })

  it('closed session rejects resumeRun', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'wait', args: {}, id: 'tool-wait' },
        ]),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry().registerTool({
        spec: { name: 'wait', description: 'Wait', parameters: { type: 'object' } },
        execute: async (_args, context) => {
          toolSignalSeen.resolve(context.abortSignal)
          await new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener('abort', () => {
              reject(createAbortError('closed'))
            }, { once: true })
          })
          throw new Error('Unreachable')
        },
        sideEffect: 'idempotent',
      }),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-snap-closed-resume'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-snap-crs', 'wait'),
    })
    const eventsPromise = collectRuntimeEvents(runId, runtime)
    await toolSignalSeen.promise
    runtime.cancelRun(runId)
    await eventsPromise
    await waitForRunStatus(runtime, runId, 'cancelled')

    await runtime.closeSession(session.sessionId)

    await expect(runtime.resumeRun({ runId })).rejects.toMatchObject({
      code: 'SESSION_CLOSED',
    })
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && pnpm vitest run src/__tests__/suite/snapshot-consistency.test.ts`
Expected: 所有用例 PASS

- [ ] **Step 3: 修复失败用例（如有）**

- [ ] **Step 4: Commit**

```
test(runtime): 添加快照一致性集成测试
```

---

## Task 5: error-recovery.test.ts — 错误恢复与降级

**Files:**
- Create: `packages/runtime/src/__tests__/suite/error-recovery.test.ts`

- [ ] **Step 1: 编写测试文件**

```typescript
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { DEFAULT_EXECUTION_POLICY, createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createSessionRuntime } from '../../runtime.js'
import { InMemorySnapshotStore } from '../../snapshot-store.js'
import { ToolRegistry } from '../../tool-catalog.js'
import {
  collectRuntimeEvents,
  collectRuntimeOutcome,
  createAbortError,
  createDeferred,
  createMockTool,
  createToolRegistry,
  createUserMessage,
  waitForRunStatus,
} from '../helpers/runtime-test-utils.js'

describe('suite/error-recovery', () => {
  it('reports run.failed when tool throws', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'explode', args: {}, id: 'tool-explode' },
        ]),
      },
      snapshotStore,
      toolCatalog: createToolRegistry(
        createMockTool('explode', { error: new Error('boom') })
      ),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-err-tool-throw'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-err-1', 'explode'),
    })
    const { events, error } = await collectRuntimeOutcome(runId, runtime)

    expect(error).toBeDefined()
    const toolFailed = events.find((e) => e.type === 'tool.failed')
    expect(toolFailed).toBeDefined()

    const runSnapshot = await waitForRunStatus(runtime, runId, 'failed')
    expect(runSnapshot.status).toBe('failed')
    expect(runSnapshot.metadata).toHaveProperty('failureCode')
  })

  it('allows new runTurn on same session after a failed run', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    // 第一个 runtime 触发失败
    const failRuntime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'explode', args: {}, id: 'tool-fail-1' },
        ]),
      },
      snapshotStore,
      toolCatalog: createToolRegistry(
        createMockTool('explode', { error: new Error('fail') })
      ),
    })

    const session = await failRuntime.createSession({
      sessionId: createSessionId('session-err-recover'),
    })
    const failedRunId = await failRuntime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-err-r1', 'fail'),
    })
    await collectRuntimeOutcome(failedRunId, failRuntime)
    await waitForRunStatus(failRuntime, failedRunId, 'failed')

    // 第二个 runtime 成功执行
    const successRuntime = createSessionRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('recovered')) },
      snapshotStore,
      toolCatalog: createToolRegistry(),
    })
    const successRunId = await successRuntime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-err-r2', 'try again'),
    })
    const { events } = await collectRuntimeOutcome(successRunId, successRuntime)

    expect(events.map((e) => e.type)).toContain('run.completed')
  })

  it('cancels run and produces run.cancelled event', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'slow', args: {}, id: 'tool-cancel' },
        ]),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry().registerTool({
        spec: { name: 'slow', description: 'Slow', parameters: { type: 'object' } },
        execute: async (_args, context) => {
          toolSignalSeen.resolve(context.abortSignal)
          await new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener('abort', () => {
              reject(createAbortError('cancelled'))
            }, { once: true })
          })
          throw new Error('Unreachable')
        },
        sideEffect: 'idempotent',
      }),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-err-cancel'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-err-cancel', 'slow'),
    })
    const eventsPromise = collectRuntimeEvents(runId, runtime)
    await toolSignalSeen.promise

    expect(runtime.cancelRun(runId)).toBe(true)

    const events = await eventsPromise
    expect(events.map((e) => e.type)).toContain('run.cancelled')
  })

  it('marks aborted-with-side-effect for destructive tool cancellation', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'delete', args: {}, id: 'tool-delete' },
        ]),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry().registerTool({
        spec: { name: 'delete', description: 'Delete', parameters: { type: 'object' } },
        execute: async (_args, context) => {
          toolSignalSeen.resolve(context.abortSignal)
          await new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener('abort', () => {
              reject(createAbortError('cancelled'))
            }, { once: true })
          })
          throw new Error('Unreachable')
        },
        sideEffect: 'destructive',
      }),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-err-destructive'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-err-dest', 'delete'),
      policy: {
        ...DEFAULT_EXECUTION_POLICY,
        tool: { ...DEFAULT_EXECUTION_POLICY.tool, allowDestructive: true },
      },
    })
    const eventsPromise = collectRuntimeEvents(runId, runtime)
    await toolSignalSeen.promise
    runtime.cancelRun(runId)
    await eventsPromise

    const runSnapshot = await waitForRunStatus(runtime, runId, 'cancelled')
    expect(runSnapshot.pendingOperations[0]?.status).toBe('aborted-with-side-effect')
    expect(runSnapshot.resumeHint).toBe('require-user-confirmation')
  })

  it('marks aborted-clean for none/idempotent tool cancellation', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'safe', args: {}, id: 'tool-safe-cancel' },
        ]),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry().registerTool({
        spec: { name: 'safe', description: 'Safe', parameters: { type: 'object' } },
        execute: async (_args, context) => {
          toolSignalSeen.resolve(context.abortSignal)
          await new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener('abort', () => {
              reject(createAbortError('cancelled'))
            }, { once: true })
          })
          throw new Error('Unreachable')
        },
        sideEffect: 'none',
      }),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-err-safe-cancel'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-err-safe', 'safe'),
    })
    const eventsPromise = collectRuntimeEvents(runId, runtime)
    await toolSignalSeen.promise
    runtime.cancelRun(runId)
    await eventsPromise

    const runSnapshot = await waitForRunStatus(runtime, runId, 'cancelled')
    expect(runSnapshot.pendingOperations[0]?.status).toBe('aborted-clean')
    expect(runSnapshot.resumeHint).toBe('replay')
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && pnpm vitest run src/__tests__/suite/error-recovery.test.ts`
Expected: 所有用例 PASS

- [ ] **Step 3: 修复失败用例（如有）**

- [ ] **Step 4: Commit**

```
test(runtime): 添加错误恢复与降级集成测试
```

---

## Task 6: concurrency.test.ts — 并发安全

**Files:**
- Create: `packages/runtime/src/__tests__/suite/concurrency.test.ts`

- [ ] **Step 1: 编写测试文件**

```typescript
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createSessionRuntime } from '../../runtime.js'
import { InMemorySnapshotStore } from '../../snapshot-store.js'
import { ToolRegistry } from '../../tool-catalog.js'
import {
  assertRunCompleted,
  collectRuntimeEvents,
  collectRuntimeOutcome,
  createAbortError,
  createDeferred,
  createMockTool,
  createToolRegistry,
  createUserMessage,
  readTextContent,
  waitForRunStatus,
} from '../helpers/runtime-test-utils.js'

describe('suite/concurrency', () => {
  it('two different sessions run concurrently to completion', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respond(new AIMessage('answer-A'))
          .respond(new AIMessage('answer-B')),
      },
      snapshotStore,
      toolCatalog: createToolRegistry(),
    })

    const sessionA = await runtime.createSession({
      sessionId: createSessionId('session-conc-A'),
    })
    const sessionB = await runtime.createSession({
      sessionId: createSessionId('session-conc-B'),
    })

    const runIdA = await runtime.runTurn({
      sessionId: sessionA.sessionId,
      message: createUserMessage('msg-conc-A', 'hello A'),
    })
    const runIdB = await runtime.runTurn({
      sessionId: sessionB.sessionId,
      message: createUserMessage('msg-conc-B', 'hello B'),
    })

    const [eventsA, eventsB] = await Promise.all([
      collectRuntimeEvents(runIdA, runtime),
      collectRuntimeEvents(runIdB, runtime),
    ])

    assertRunCompleted(eventsA)
    assertRunCompleted(eventsB)

    // 事件流的 sessionId 严格对应
    for (const event of eventsA) {
      if ('sessionId' in event) {
        expect(event.sessionId).toBe(sessionA.sessionId)
      }
    }
    for (const event of eventsB) {
      if ('sessionId' in event) {
        expect(event.sessionId).toBe(sessionB.sessionId)
      }
    }
  })

  it('concurrent run snapshots are independent', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respond(new AIMessage('only-A'))
          .respond(new AIMessage('only-B')),
      },
      snapshotStore,
      toolCatalog: createToolRegistry(),
    })

    const sessionA = await runtime.createSession({
      sessionId: createSessionId('session-conc-snap-A'),
    })
    const sessionB = await runtime.createSession({
      sessionId: createSessionId('session-conc-snap-B'),
    })

    const runIdA = await runtime.runTurn({
      sessionId: sessionA.sessionId,
      message: createUserMessage('msg-conc-sA', 'A'),
    })
    const runIdB = await runtime.runTurn({
      sessionId: sessionB.sessionId,
      message: createUserMessage('msg-conc-sB', 'B'),
    })

    await Promise.all([
      collectRuntimeEvents(runIdA, runtime),
      collectRuntimeEvents(runIdB, runtime),
    ])

    const snapA = await runtime.getSessionSnapshot(sessionA.sessionId)
    const snapB = await runtime.getSessionSnapshot(sessionB.sessionId)

    // A 的消息不包含 B 的内容，反之亦然
    const textA = snapA?.messages.map((m) => readTextContent(m)).join(' ') ?? ''
    const textB = snapB?.messages.map((m) => readTextContent(m)).join(' ') ?? ''

    expect(textA).not.toContain('only-B')
    expect(textB).not.toContain('only-A')
  })

  it('one session failure does not affect another session', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    // 失败 session
    const failRuntime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'bomb', args: {}, id: 'tool-bomb' },
        ]),
      },
      snapshotStore,
      toolCatalog: createToolRegistry(createMockTool('bomb', { error: new Error('boom') })),
    })
    // 成功 session
    const okRuntime = createSessionRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('fine')) },
      snapshotStore,
      toolCatalog: createToolRegistry(),
    })

    const sessionA = await failRuntime.createSession({
      sessionId: createSessionId('session-conc-fail-A'),
    })
    const sessionB = await okRuntime.createSession({
      sessionId: createSessionId('session-conc-ok-B'),
    })

    const runIdA = await failRuntime.runTurn({
      sessionId: sessionA.sessionId,
      message: createUserMessage('msg-conc-fA', 'bomb'),
    })
    const runIdB = await okRuntime.runTurn({
      sessionId: sessionB.sessionId,
      message: createUserMessage('msg-conc-oB', 'hello'),
    })

    const [resultA, resultB] = await Promise.all([
      collectRuntimeOutcome(runIdA, failRuntime),
      collectRuntimeOutcome(runIdB, okRuntime),
    ])

    expect(resultA.error).toBeDefined()
    assertRunCompleted(resultB.events)
  })

  it('cancelling one session run does not affect another', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()

    // 将被取消的 session
    const cancelRuntime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'block', args: {}, id: 'tool-block-conc' },
        ]),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry().registerTool({
        spec: { name: 'block', description: 'Block', parameters: { type: 'object' } },
        execute: async (_args, context) => {
          toolSignalSeen.resolve(context.abortSignal)
          await new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener('abort', () => {
              reject(createAbortError('cancelled'))
            }, { once: true })
          })
          throw new Error('Unreachable')
        },
        sideEffect: 'idempotent',
      }),
    })

    // 正常完成的 session
    const okRuntime = createSessionRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('ok')) },
      snapshotStore,
      toolCatalog: createToolRegistry(),
    })

    const sessionA = await cancelRuntime.createSession({
      sessionId: createSessionId('session-conc-cancel-A'),
    })
    const sessionB = await okRuntime.createSession({
      sessionId: createSessionId('session-conc-cancel-B'),
    })

    const runIdA = await cancelRuntime.runTurn({
      sessionId: sessionA.sessionId,
      message: createUserMessage('msg-conc-cA', 'block'),
    })
    const eventsPromiseA = collectRuntimeEvents(runIdA, cancelRuntime)
    await toolSignalSeen.promise

    const runIdB = await okRuntime.runTurn({
      sessionId: sessionB.sessionId,
      message: createUserMessage('msg-conc-cB', 'ok'),
    })

    cancelRuntime.cancelRun(runIdA)

    const [eventsA, eventsB] = await Promise.all([
      eventsPromiseA,
      collectRuntimeEvents(runIdB, okRuntime),
    ])

    expect(eventsA.map((e) => e.type)).toContain('run.cancelled')
    assertRunCompleted(eventsB)
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && pnpm vitest run src/__tests__/suite/concurrency.test.ts`
Expected: 所有用例 PASS

- [ ] **Step 3: 修复失败用例（如有）**

- [ ] **Step 4: Commit**

```
test(runtime): 添加并发安全集成测试
```

---

## Task 7: checkpoint-resume.test.ts — Checkpoint + HITL 恢复

**Files:**
- Create: `packages/runtime/src/__tests__/suite/checkpoint-resume.test.ts`

- [ ] **Step 1: 编写测试文件**

基于 `runtime-cancel-resume.test.ts:395-520` 中已验证的 HITL 模式扩展：

```typescript
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { MemorySaver } from '@langchain/langgraph'
import { createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import {
  createSessionRuntime,
  readDeepagentsRunWorkflowState,
  readRunRuntimeMetadata,
} from '../../runtime.js'
import { InMemorySnapshotStore } from '../../snapshot-store.js'
import { ToolRegistry } from '../../tool-catalog.js'
import {
  collectRuntimeEvents,
  createUserMessage,
  readTextContent,
  waitForRunStatus,
} from '../helpers/runtime-test-utils.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function createSumTool() {
  let executions = 0
  const tool = {
    spec: {
      name: 'sum',
      description: 'Add two numbers',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
    execute: async (args: unknown) => {
      if (!isRecord(args) || typeof args.a !== 'number' || typeof args.b !== 'number') {
        throw new Error('Expected numeric args')
      }
      executions += 1
      return args.a + args.b
    },
    sideEffect: 'idempotent' as const,
  }
  return { tool, getExecutions: () => executions }
}

describe('suite/checkpoint-resume', () => {
  it('interrupt produces cancelled run with HITL metadata', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const checkpointer = new MemorySaver()
    const { tool: sumTool, getExecutions } = createSumTool()
    const toolCatalog = new ToolRegistry().registerTool(sumTool)

    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'sum', args: { a: 3, b: 4 }, id: 'tool-hitl-1' },
        ]),
        checkpointer,
        interruptOn: { sum: { allowedDecisions: ['approve', 'reject'] } },
      },
      snapshotStore,
      toolCatalog,
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-cp-interrupt'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-cp-1', 'sum 3 + 4'),
    })
    const events = await collectRuntimeEvents(runId, runtime)
    const runSnapshot = await waitForRunStatus(runtime, runId, 'cancelled')

    expect(events.map((e) => e.type)).toContain('run.cancelled')
    expect(runSnapshot.status).toBe('cancelled')
    expect(runSnapshot.cancelPoint).toBe('human-in-the-loop')
    expect(runSnapshot.resumeHint).toBe('require-user-confirmation')
    expect(getExecutions()).toBe(0)
  })

  it('interrupt run workflowState contains deepagents-interrupt metadata', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const checkpointer = new MemorySaver()
    const { tool: sumTool } = createSumTool()
    const toolCatalog = new ToolRegistry().registerTool(sumTool)

    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'sum', args: { a: 1, b: 2 }, id: 'tool-hitl-ws' },
        ]),
        checkpointer,
        interruptOn: { sum: { allowedDecisions: ['approve'] } },
      },
      snapshotStore,
      toolCatalog,
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-cp-workflow'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-cp-ws', 'sum'),
    })
    await collectRuntimeEvents(runId, runtime)
    const runSnapshot = await waitForRunStatus(runtime, runId, 'cancelled')

    const workflowState = readDeepagentsRunWorkflowState(runSnapshot.workflowState)
    expect(workflowState).toMatchObject({
      kind: 'deepagents-interrupt',
      threadId: session.sessionId,
      checkpointId: expect.any(String),
    })
    expect(workflowState?.interrupts.length).toBeGreaterThan(0)
  })

  it('resumeRun successfully resumes after interrupt', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const checkpointer = new MemorySaver()
    const { tool: sumTool, getExecutions } = createSumTool()
    const toolCatalog = new ToolRegistry().registerTool(sumTool)

    const interruptRuntime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'sum', args: { a: 5, b: 6 }, id: 'tool-hitl-resume' },
        ]),
        checkpointer,
        interruptOn: { sum: { allowedDecisions: ['approve'] } },
      },
      snapshotStore,
      toolCatalog,
    })

    const session = await interruptRuntime.createSession({
      sessionId: createSessionId('session-cp-resume'),
    })
    const interruptedRunId = await interruptRuntime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-cp-r1', 'sum 5+6'),
    })
    await collectRuntimeEvents(interruptedRunId, interruptRuntime)
    await waitForRunStatus(interruptRuntime, interruptedRunId, 'cancelled')

    const resumeRuntime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage('approved sum 11')),
        checkpointer,
        interruptOn: { sum: { allowedDecisions: ['approve'] } },
      },
      snapshotStore,
      toolCatalog,
    })

    const resumedRunId = await resumeRuntime.resumeRun({
      runId: interruptedRunId,
      resumeValue: { decisions: [{ type: 'approve' }] },
    })
    const resumedEvents = await collectRuntimeEvents(resumedRunId, resumeRuntime)
    const resumedRun = await waitForRunStatus(resumeRuntime, resumedRunId, 'completed')

    expect(resumedRun.triggerType).toBe('resume')
    expect(resumedRun.parentRunId).toBe(interruptedRunId)
    expect(resumedEvents.map((e) => e.type)).toContain('run.completed')
    expect(getExecutions()).toBe(1)

    const sessionSnapshot = await resumeRuntime.getSessionSnapshot(session.sessionId)
    expect(readTextContent(sessionSnapshot?.messages.at(-1))).toBe('approved sum 11')
  })

  it('resumeRun rejects missing resumeValue for checkpoint-based resume', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const checkpointer = new MemorySaver()
    const { tool: sumTool } = createSumTool()
    const toolCatalog = new ToolRegistry().registerTool(sumTool)

    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'sum', args: { a: 1, b: 1 }, id: 'tool-hitl-norv' },
        ]),
        checkpointer,
        interruptOn: { sum: { allowedDecisions: ['approve'] } },
      },
      snapshotStore,
      toolCatalog,
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-cp-norv'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-cp-norv', 'sum'),
    })
    await collectRuntimeEvents(runId, runtime)
    await waitForRunStatus(runtime, runId, 'cancelled')

    await expect(runtime.resumeRun({ runId })).rejects.toMatchObject({
      code: 'MISSING_RESUME_VALUE',
    })
  })

  it('resumeRun rejects non-cancelled run', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('ok')) },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-cp-not-cancelled'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-cp-nc', 'ok'),
    })
    await collectRuntimeEvents(runId, runtime)
    await waitForRunStatus(runtime, runId, 'completed')

    await expect(runtime.resumeRun({ runId })).rejects.toMatchObject({
      code: 'RUN_NOT_CANCELLABLE',
    })
  })

  it('resume records resumedFromRunId in metadata', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const checkpointer = new MemorySaver()
    const { tool: sumTool } = createSumTool()
    const toolCatalog = new ToolRegistry().registerTool(sumTool)

    const interruptRuntime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'sum', args: { a: 1, b: 1 }, id: 'tool-hitl-meta' },
        ]),
        checkpointer,
        interruptOn: { sum: { allowedDecisions: ['approve'] } },
      },
      snapshotStore,
      toolCatalog,
    })

    const session = await interruptRuntime.createSession({
      sessionId: createSessionId('session-cp-meta'),
    })
    const interruptedRunId = await interruptRuntime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-cp-meta', 'sum'),
    })
    await collectRuntimeEvents(interruptedRunId, interruptRuntime)
    await waitForRunStatus(interruptRuntime, interruptedRunId, 'cancelled')

    const resumeRuntime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage('approved')),
        checkpointer,
        interruptOn: { sum: { allowedDecisions: ['approve'] } },
      },
      snapshotStore,
      toolCatalog,
    })

    const resumedRunId = await resumeRuntime.resumeRun({
      runId: interruptedRunId,
      resumeValue: { decisions: [{ type: 'approve' }] },
    })
    await collectRuntimeEvents(resumedRunId, resumeRuntime)
    const resumedRun = await waitForRunStatus(resumeRuntime, resumedRunId, 'completed')

    expect(resumedRun.metadata).toMatchObject({
      resumedFromRunId: interruptedRunId,
    })
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && pnpm vitest run src/__tests__/suite/checkpoint-resume.test.ts`
Expected: 所有用例 PASS

- [ ] **Step 3: 修复失败用例（如有）**

- [ ] **Step 4: Commit**

```
test(runtime): 添加 checkpoint 与 HITL 恢复集成测试
```

---

## Task 8: agent-test-utils.ts + session-e2e.test.ts — Agent 层

**Files:**
- Create: `packages/agent/src/__tests__/helpers/agent-test-utils.ts`
- Create: `packages/agent/src/__tests__/suite/session-e2e.test.ts`

- [ ] **Step 1: 创建 agent-test-utils.ts**

```typescript
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { InMemorySnapshotStore, type SessionRuntime, createSessionRuntime } from '@tianji/runtime'
import { ToolRegistry } from '@tianji/runtime'
import type { RuntimeEvent } from '@tianji/shared'

import type { AgentSession, ChatOptions } from '../../session.js'

/**
 * 构造最小可用的测试用 SessionRuntime，不依赖文件系统。
 * 内置 InMemorySnapshotStore 和 FakeListChatModel。
 */
export function createTestRuntime(responses: string[]): SessionRuntime {
  return createSessionRuntime({
    deepagents: {
      model: new FakeListChatModel({ responses }),
    },
    snapshotStore: new InMemorySnapshotStore(),
    toolCatalog: new ToolRegistry(),
  })
}

/**
 * 调用 session.chat() 并收集全部事件。
 */
export async function collectChatEvents(
  session: AgentSession,
  prompt: string,
  options?: ChatOptions
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []

  for await (const event of session.chat(prompt, options)) {
    events.push(event)
  }

  return events
}
```

- [ ] **Step 2: 创建 session-e2e.test.ts**

```typescript
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import {
  InMemorySnapshotStore,
  type SessionRuntime,
  createSessionRuntime,
} from '@tianji/runtime'
import { ToolRegistry } from '@tianji/runtime'
import type { RuntimeEvent, SessionId } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import * as runtimeModule from '@tianji/runtime'
import type { LoadedAgentContext } from '../../context.js'
import { createAgentSession, type AgentSession } from '../../session.js'
import { collectChatEvents } from '../helpers/agent-test-utils.js'

vi.mock('@tianji/runtime', async () => {
  const actual = await vi.importActual<typeof import('@tianji/runtime')>('@tianji/runtime')
  return {
    ...actual,
    createSessionRuntime: vi.fn(actual.createSessionRuntime),
  }
})

function createTestContext(overrides?: {
  model?: InstanceType<typeof FakeListChatModel>
}): LoadedAgentContext {
  return {
    paths: {
      configDir: '/tmp/tianji-test/config',
      agentsDir: '/tmp/tianji-test/config/agents',
      logsDir: '/tmp/tianji-test/config/logs',
      configFilePath: '/tmp/tianji-test/config/tianji.json',
      cliLogFilePath: '/tmp/tianji-test/config/logs/tianji.log',
      daemonPortPath: '/tmp/tianji-test/config/daemon.port',
      daemonPidPath: '/tmp/tianji-test/config/daemon.pid',
    },
    config: {},
    agent: {
      agentName: 'default',
      modelRef: 'openai/gpt-4.1',
      provider: 'openai',
      modelName: 'gpt-4.1',
      providerConfig: { apiKey: 'test-key' },
      soulPath: '/tmp/tianji-test/config/agents/default/SOUL.md',
      soul: 'You are a test agent.',
    },
    resolvedEnvVars: [],
    snapshotStore: new InMemorySnapshotStore() as never,
  }
}

describe('suite/session-e2e', () => {
  it('session.chat returns complete event flow', async () => {
    const mockRuntime: SessionRuntime = {
      createSession: vi.fn(async (options) => ({
        sessionId: options?.sessionId ?? ('session_test' as SessionId),
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      })),
      closeSession: vi.fn(async () => ({
        sessionId: 'session_test' as SessionId,
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      })),
      getSessionSnapshot: vi.fn(async () => undefined),
      getRunSnapshot: vi.fn(async () => undefined),
      runTurn: vi.fn(async () => 'run_test' as never),
      resumeRun: vi.fn(async () => 'run_test' as never),
      streamEvents: vi.fn(async function* () {
        yield {
          type: 'run.started' as const,
          runId: 'run_test' as never,
          sessionId: 'session_test' as SessionId,
          triggerType: 'new' as const,
          parentRunId: undefined,
          timestamp: Date.now(),
        }
        yield {
          type: 'message.started' as const,
          runId: 'run_test' as never,
          messageId: 'msg_1',
          message: { id: 'msg_1', role: 'assistant' as const, content: [], createdAt: Date.now() },
          timestamp: Date.now(),
        }
        yield {
          type: 'message.completed' as const,
          runId: 'run_test' as never,
          messageId: 'msg_1',
          message: {
            id: 'msg_1',
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: 'hello' }],
            createdAt: Date.now(),
          },
          timestamp: Date.now(),
        }
        yield {
          type: 'run.completed' as const,
          runId: 'run_test' as never,
          sessionId: 'session_test' as SessionId,
          triggerType: 'new' as const,
          parentRunId: undefined,
          timestamp: Date.now(),
        }
      }),
      cancelRun: vi.fn(() => false),
    }

    vi.spyOn(runtimeModule, 'createSessionRuntime').mockReturnValue(mockRuntime)

    const context = createTestContext()
    const session = createAgentSession(context)
    const events = await collectChatEvents(session, 'hello')

    const types = events.map((e) => e.type)
    expect(types).toContain('run.started')
    expect(types).toContain('message.started')
    expect(types).toContain('message.completed')
    expect(types).toContain('run.completed')
  })

  it('systemPrompt defaults to agent soul', async () => {
    const mockRuntime: SessionRuntime = {
      createSession: vi.fn(async (options) => ({
        sessionId: options?.sessionId ?? ('session_test' as SessionId),
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      })),
      closeSession: vi.fn(async () => ({
        sessionId: 'session_test' as SessionId,
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      })),
      getSessionSnapshot: vi.fn(async () => undefined),
      getRunSnapshot: vi.fn(async () => undefined),
      runTurn: vi.fn(async () => 'run_test' as never),
      resumeRun: vi.fn(async () => 'run_test' as never),
      streamEvents: vi.fn(async function* () {
        yield {
          type: 'run.completed' as const,
          runId: 'run_test' as never,
          sessionId: 'session_test' as SessionId,
          triggerType: 'new' as const,
          parentRunId: undefined,
          timestamp: Date.now(),
        }
      }),
      cancelRun: vi.fn(() => false),
    }

    vi.spyOn(runtimeModule, 'createSessionRuntime').mockReturnValue(mockRuntime)

    const context = createTestContext()
    const session = createAgentSession(context)
    await collectChatEvents(session, 'hi')

    expect(mockRuntime.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'You are a test agent.',
      })
    )
  })

  it('ChatOptions.systemPrompt overrides default soul', async () => {
    const mockRuntime: SessionRuntime = {
      createSession: vi.fn(async (options) => ({
        sessionId: options?.sessionId ?? ('session_test' as SessionId),
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      })),
      closeSession: vi.fn(async () => ({
        sessionId: 'session_test' as SessionId,
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      })),
      getSessionSnapshot: vi.fn(async () => undefined),
      getRunSnapshot: vi.fn(async () => undefined),
      runTurn: vi.fn(async () => 'run_test' as never),
      resumeRun: vi.fn(async () => 'run_test' as never),
      streamEvents: vi.fn(async function* () {
        yield {
          type: 'run.completed' as const,
          runId: 'run_test' as never,
          sessionId: 'session_test' as SessionId,
          triggerType: 'new' as const,
          parentRunId: undefined,
          timestamp: Date.now(),
        }
      }),
      cancelRun: vi.fn(() => false),
    }

    vi.spyOn(runtimeModule, 'createSessionRuntime').mockReturnValue(mockRuntime)

    const context = createTestContext()
    const session = createAgentSession(context)
    await collectChatEvents(session, 'hi', { systemPrompt: 'custom prompt' })

    expect(mockRuntime.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'custom prompt',
      })
    )
  })

  it('session uses a stable sessionId', async () => {
    const mockRuntime: SessionRuntime = {
      createSession: vi.fn(async (options) => ({
        sessionId: options?.sessionId ?? ('session_test' as SessionId),
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      })),
      closeSession: vi.fn(async () => ({
        sessionId: 'session_test' as SessionId,
        messages: [],
        createdAt: 1,
        updatedAt: 1,
      })),
      getSessionSnapshot: vi.fn(async () => undefined),
      getRunSnapshot: vi.fn(async () => undefined),
      runTurn: vi.fn(async () => 'run_test' as never),
      resumeRun: vi.fn(async () => 'run_test' as never),
      streamEvents: vi.fn(async function* () {
        yield {
          type: 'run.completed' as const,
          runId: 'run_test' as never,
          sessionId: 'session_test' as SessionId,
          triggerType: 'new' as const,
          parentRunId: undefined,
          timestamp: Date.now(),
        }
      }),
      cancelRun: vi.fn(() => false),
    }

    vi.spyOn(runtimeModule, 'createSessionRuntime').mockReturnValue(mockRuntime)

    const context = createTestContext()
    const session = createAgentSession(context)

    expect(session.sessionId).toBeDefined()
    expect(typeof session.sessionId).toBe('string')
    expect(session.sessionId).toMatch(/^session_\d+$/)
  })
})
```

- [ ] **Step 3: 运行 agent 测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm vitest run src/__tests__/suite/session-e2e.test.ts`
Expected: 所有用例 PASS

- [ ] **Step 4: 修复失败用例（如有）**

- [ ] **Step 5: Commit**

```
test(agent): 添加 agent session 端到端集成测试
```

---

## Task 9: 全量回归验证

- [ ] **Step 1: 运行 runtime 全部测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && pnpm vitest run`
Expected: 所有测试 PASS（包括原有测试和新增 suite 测试）

- [ ] **Step 2: 运行 agent 全部测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm vitest run`
Expected: 所有测试 PASS

- [ ] **Step 3: 运行 pnpm check**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: 无错误

- [ ] **Step 4: 修复回归问题（如有）**

- [ ] **Step 5: 最终 Commit**

```
test: 核心层集成测试套件全量通过
```
