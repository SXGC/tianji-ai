# 核心包测试质量整改 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复审计报告中确认的 6 类测试质量问题，使测试真正验证业务行为而非实现细节。

**Architecture:** 按审计报告建议的优先级依次修复：snapshot-store 补齐覆盖 → tracing-spans 验证 attribute → error-recovery 修正恢复语义 → tool-catalog 补齐边界 → try/catch 反模式批量修复 → shared 类型见证清理。每个 task 独立可测试。

**Tech Stack:** TypeScript, Vitest, @opentelemetry/api, @tianji/shared, @tianji/runtime

---

### Task 1: snapshot-store.test.ts — 补齐 InMemorySnapshotStore 覆盖

**Files:**
- Modify: `packages/runtime/src/__tests__/snapshot-store.test.ts`

- [ ] **Step 1: 写 InMemorySnapshotStore 的 run 操作和边界测试**

在现有 `describe('InMemorySnapshotStore')` 块内追加以下测试用例：

```typescript
it('saves and loads run snapshots', async () => {
  const store = new InMemorySnapshotStore()
  const run: RunSnapshot = {
    runId: createRunId('run-mem-1'),
    sessionId: createSessionId('session-mem-runs'),
    status: 'completed',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    pendingOperations: [],
  }

  await store.saveRun(run)

  await expect(store.loadRun(run.runId)).resolves.toEqual(run)
})

it('lists runs filtered by sessionId and sorted by createdAt', async () => {
  const store = new InMemorySnapshotStore()
  const sessionA = createSessionId('session-a')
  const sessionB = createSessionId('session-b')
  const runA1: RunSnapshot = {
    runId: createRunId('run-a1'),
    sessionId: sessionA,
    status: 'completed',
    messages: [],
    createdAt: 2,
    updatedAt: 2,
    pendingOperations: [],
  }
  const runA2: RunSnapshot = {
    runId: createRunId('run-a2'),
    sessionId: sessionA,
    status: 'completed',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    pendingOperations: [],
  }
  const runB1: RunSnapshot = {
    runId: createRunId('run-b1'),
    sessionId: sessionB,
    status: 'completed',
    messages: [],
    createdAt: 3,
    updatedAt: 3,
    pendingOperations: [],
  }

  await store.saveRun(runA1)
  await store.saveRun(runA2)
  await store.saveRun(runB1)

  const runsA = await store.listRuns(sessionA)
  expect(runsA).toEqual([runA2, runA1])

  const runsB = await store.listRuns(sessionB)
  expect(runsB).toEqual([runB1])
})

it('returns undefined for non-existent session or run', async () => {
  const store = new InMemorySnapshotStore()

  await expect(store.loadSession(createSessionId('ghost'))).resolves.toBeUndefined()
  await expect(store.loadRun(createRunId('ghost'))).resolves.toBeUndefined()
  await expect(store.listRuns(createSessionId('ghost'))).resolves.toEqual([])
})

it('overwrites snapshot on duplicate save', async () => {
  const store = new InMemorySnapshotStore()
  const sessionId = createSessionId('session-overwrite')
  const original: SessionSnapshot = {
    sessionId,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  }
  const updated: SessionSnapshot = {
    sessionId,
    messages: [],
    createdAt: 1,
    updatedAt: 2,
  }

  await store.saveSession(original)
  await store.saveSession(updated)

  await expect(store.loadSession(sessionId)).resolves.toEqual(updated)
})

it('clones on save and load to ensure isolation', async () => {
  const store = new InMemorySnapshotStore()
  const snapshot: SessionSnapshot = {
    sessionId: createSessionId('session-clone'),
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  }

  await store.saveSession(snapshot)

  const loaded = await store.loadSession(snapshot.sessionId)
  expect(loaded).toEqual(snapshot)

  // Mutating the loaded snapshot must not affect the stored copy
  loaded!.messages.push({
    id: 'injected',
    role: 'user',
    content: [{ type: 'text', text: 'injected' }],
    createdAt: 999,
  })

  const reloaded = await store.loadSession(snapshot.sessionId)
  expect(reloaded!.messages).toEqual([])
})
```

- [ ] **Step 2: 运行测试验证通过**

Run: `cd packages/runtime && pnpm vitest run src/__tests__/snapshot-store.test.ts`
Expected: 所有新增和原有测试均 PASS

- [ ] **Step 3: 补齐 FileSnapshotStore 的 session 操作和边界测试**

在现有 `describe('FileSnapshotStore')` 块内追加：

```typescript
it('saves and loads session snapshots', async () => {
  const store = new FileSnapshotStore(directory)
  const snapshot: SessionSnapshot = {
    sessionId: createSessionId('session-file-save'),
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  }

  await store.saveSession(snapshot)

  await expect(store.loadSession(snapshot.sessionId)).resolves.toEqual(snapshot)
})

it('returns undefined for non-existent session or run', async () => {
  const store = new FileSnapshotStore(directory)

  await expect(store.loadSession(createSessionId('ghost'))).resolves.toBeUndefined()
  await expect(store.loadRun(createRunId('ghost'))).resolves.toBeUndefined()
})

it('returns empty array when listing runs for session with no runs directory', async () => {
  const store = new FileSnapshotStore(directory)

  await expect(store.listRuns(createSessionId('no-runs'))).resolves.toEqual([])
})

it('overwrites run snapshot on duplicate save', async () => {
  const store = new FileSnapshotStore(directory)
  const runId = createRunId('run-overwrite')
  const sessionId = createSessionId('session-overwrite-file')
  const original: RunSnapshot = {
    runId,
    sessionId,
    status: 'running',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    pendingOperations: [],
  }
  const updated: RunSnapshot = {
    ...original,
    status: 'completed',
    updatedAt: 2,
  }

  await store.saveRun(original)
  await store.saveRun(updated)

  await expect(store.loadRun(runId)).resolves.toEqual(updated)
})
```

- [ ] **Step 4: 运行测试验证通过**

Run: `cd packages/runtime && pnpm vitest run src/__tests__/snapshot-store.test.ts`
Expected: 所有测试 PASS

- [ ] **Step 5: 提交**

```bash
git add packages/runtime/src/__tests__/snapshot-store.test.ts
git commit -m "test(runtime): 补齐 snapshot-store 的 run 操作、不存在 ID、覆盖写入和 clone 隔离测试"
```

---

### Task 2: tracing-spans.test.ts — 用 spy 验证 attribute 内容

**Files:**
- Modify: `packages/observer/src/tracing/__tests__/tracing-spans.test.ts`

注意：项目没有安装 `@opentelemetry/sdk-trace-base`（InMemorySpanExporter 不可用），但可以通过 `vi.spyOn` 拦截 `tracer.startSpan` 来验证传入的 attributes 参数。

- [ ] **Step 1: 重写 attribute 验证测试**

替换现有的 `describe('span functions when tracing is initialized')` 块。核心策略：在 `initTracing` 之后获取 tracer，对 `tracer.startSpan` 添加 spy，然后验证调用参数中的 attributes。

```typescript
import { SpanKind, trace } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { initTracing, shutdownTracing } from '../index.js'
import { startLlmCallSpan, startRunSpan, startSessionSpan, startToolSpan } from '../spans.js'

afterEach(async () => {
  await shutdownTracing()
})

describe('span functions when tracing is not initialized', () => {
  it('startSessionSpan returns undefined', () => {
    expect(startSessionSpan({ sessionId: 'sess-1' })).toBeUndefined()
  })

  it('startRunSpan returns undefined', () => {
    expect(startRunSpan({ runId: 'run-1' })).toBeUndefined()
  })

  it('startToolSpan returns undefined', () => {
    expect(startToolSpan({ toolName: 'search' })).toBeUndefined()
  })

  it('startLlmCallSpan returns undefined', () => {
    expect(startLlmCallSpan({ provider: 'openai', model: 'gpt-4' })).toBeUndefined()
  })
})

describe('span functions when tracing is initialized', () => {
  /** 获取 tracer 并返回 startSpan 的 spy */
  function spyOnTracer() {
    initTracing({ serviceName: 'test-spans', exporters: [] })
    const tracer = trace.getTracer('test-spans')
    return vi.spyOn(tracer, 'startSpan')
  }

  it('startSessionSpan sets tianji.session.id attribute', () => {
    const spy = spyOnTracer()

    const result = startSessionSpan({ sessionId: 'sess-1' })

    expect(result).toBeDefined()
    expect(spy).toHaveBeenCalledWith('session', expect.objectContaining({
      kind: SpanKind.INTERNAL,
      attributes: { 'tianji.session.id': 'sess-1' },
    }))
    result!.end()
  })

  it('startRunSpan sets tianji.run.id attribute', () => {
    const spy = spyOnTracer()

    const result = startRunSpan({ runId: 'run-1' })

    expect(result).toBeDefined()
    expect(spy).toHaveBeenCalledWith('run', expect.objectContaining({
      kind: SpanKind.INTERNAL,
      attributes: { 'tianji.run.id': 'run-1' },
    }))
    result!.end()
  })

  it('startRunSpan includes tianji.session.id when sessionId is provided', () => {
    const spy = spyOnTracer()

    const result = startRunSpan({ runId: 'run-1', sessionId: 'sess-1' })

    expect(result).toBeDefined()
    expect(spy).toHaveBeenCalledWith('run', expect.objectContaining({
      attributes: expect.objectContaining({
        'tianji.run.id': 'run-1',
        'tianji.session.id': 'sess-1',
      }),
    }))
    result!.end()
  })

  it('startRunSpan omits tianji.session.id when sessionId is undefined', () => {
    const spy = spyOnTracer()

    startRunSpan({ runId: 'run-1' })

    const attrs = spy.mock.calls[0]?.[1]?.attributes as Record<string, string> | undefined
    expect(attrs).toBeDefined()
    expect(attrs!['tianji.run.id']).toBe('run-1')
    expect('tianji.session.id' in attrs!).toBe(false)
  })

  it('startToolSpan sets tianji.tool.name attribute', () => {
    const spy = spyOnTracer()

    const result = startToolSpan({ toolName: 'file_search' })

    expect(result).toBeDefined()
    expect(spy).toHaveBeenCalledWith('tool', expect.objectContaining({
      attributes: { 'tianji.tool.name': 'file_search' },
    }))
    result!.end()
  })

  it('startToolSpan includes tianji.run.id when runId is provided', () => {
    const spy = spyOnTracer()

    startToolSpan({ toolName: 'file_search', runId: 'run-1' })

    expect(spy).toHaveBeenCalledWith('tool', expect.objectContaining({
      attributes: expect.objectContaining({
        'tianji.tool.name': 'file_search',
        'tianji.run.id': 'run-1',
      }),
    }))
  })

  it('startToolSpan omits tianji.run.id when runId is undefined', () => {
    const spy = spyOnTracer()

    startToolSpan({ toolName: 'file_search' })

    const attrs = spy.mock.calls[0]?.[1]?.attributes as Record<string, string> | undefined
    expect(attrs).toBeDefined()
    expect(attrs!['tianji.tool.name']).toBe('file_search')
    expect('tianji.run.id' in attrs!).toBe(false)
  })

  it('startLlmCallSpan sets provider and model attributes', () => {
    const spy = spyOnTracer()

    const result = startLlmCallSpan({ provider: 'openai', model: 'gpt-4' })

    expect(result).toBeDefined()
    expect(spy).toHaveBeenCalledWith('llm.call', expect.objectContaining({
      attributes: {
        'tianji.llm.provider': 'openai',
        'tianji.llm.model': 'gpt-4',
      },
    }))
    result!.end()
  })

  it('startLlmCallSpan includes optional sessionId and runId', () => {
    const spy = spyOnTracer()

    startLlmCallSpan({
      provider: 'anthropic',
      model: 'claude-3',
      sessionId: 'sess-1',
      runId: 'run-1',
    })

    expect(spy).toHaveBeenCalledWith('llm.call', expect.objectContaining({
      attributes: expect.objectContaining({
        'tianji.llm.provider': 'anthropic',
        'tianji.llm.model': 'claude-3',
        'tianji.session.id': 'sess-1',
        'tianji.run.id': 'run-1',
      }),
    }))
  })

  it('startLlmCallSpan omits sessionId and runId when undefined', () => {
    const spy = spyOnTracer()

    startLlmCallSpan({ provider: 'openai', model: 'gpt-4' })

    const attrs = spy.mock.calls[0]?.[1]?.attributes as Record<string, string> | undefined
    expect(attrs).toBeDefined()
    expect('tianji.session.id' in attrs!).toBe(false)
    expect('tianji.run.id' in attrs!).toBe(false)
  })

  it('startLlmCallSpan includes only sessionId when runId is undefined', () => {
    const spy = spyOnTracer()

    startLlmCallSpan({ provider: 'openai', model: 'gpt-4', sessionId: 'sess-1' })

    const attrs = spy.mock.calls[0]?.[1]?.attributes as Record<string, string> | undefined
    expect(attrs!['tianji.session.id']).toBe('sess-1')
    expect('tianji.run.id' in attrs!).toBe(false)
  })

  it('startLlmCallSpan includes only runId when sessionId is undefined', () => {
    const spy = spyOnTracer()

    startLlmCallSpan({ provider: 'openai', model: 'gpt-4', runId: 'run-1' })

    const attrs = spy.mock.calls[0]?.[1]?.attributes as Record<string, string> | undefined
    expect(attrs!['tianji.run.id']).toBe('run-1')
    expect('tianji.session.id' in attrs!).toBe(false)
  })
})

describe('startSpan internal behavior', () => {
  it('span.end() delegates to the underlying OTel span', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startSessionSpan({ sessionId: 'sess-end-test' })
    expect(result).toBeDefined()

    const endSpy = vi.spyOn(result!.span, 'end')

    result!.end()

    expect(endSpy).toHaveBeenCalledOnce()
  })

  it('multiple spans can be created and ended independently', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const session = startSessionSpan({ sessionId: 'sess-1' })
    const run = startRunSpan({ runId: 'run-1', sessionId: 'sess-1' })
    const tool = startToolSpan({ toolName: 'search', runId: 'run-1' })
    const llm = startLlmCallSpan({ provider: 'openai', model: 'gpt-4', runId: 'run-1' })

    expect(session).toBeDefined()
    expect(run).toBeDefined()
    expect(tool).toBeDefined()
    expect(llm).toBeDefined()

    llm!.end()
    tool!.end()
    run!.end()
    session!.end()
  })
})
```

- [ ] **Step 2: 运行测试验证通过**

Run: `cd packages/observer && pnpm vitest run src/tracing/__tests__/tracing-spans.test.ts`
Expected: 所有测试 PASS，且测试标题与断言内容一致

- [ ] **Step 3: 提交**

```bash
git add packages/observer/src/tracing/__tests__/tracing-spans.test.ts
git commit -m "test(observer): 用 spy 验证 tracing span 的 attribute 内容，消除假覆盖"
```

---

### Task 3: error-recovery.test.ts — 修正恢复语义测试

**Files:**
- Modify: `packages/runtime/src/__tests__/suite/error-recovery.test.ts`

- [ ] **Step 1: 修改"run 失败后同 session 可发起新 runTurn"测试**

将第 62-103 行的测试改为使用同一个 runtime 实例。核心变化：注册一个计数型工具，第一次调用抛异常，第二次正常返回。

```typescript
it('run 失败后同 session 可发起新 runTurn', async () => {
  const snapshotStore = new InMemorySnapshotStore()
  let callCount = 0
  const conditionalTool = createMockTool('conditional', {
    handler: async () => {
      callCount++
      if (callCount === 1) {
        throw new Error('first-run-error')
      }
      return 'ok'
    },
  })
  const toolRegistry = createToolRegistry(conditionalTool)

  const runtime = createSessionRuntime({
    deepagents: {
      model: fakeModel()
        .respondWithTools([{ name: 'conditional', args: {}, id: 'tool-fail-1' }])
        .respond(new AIMessage('recovered')),
    },
    snapshotStore,
    toolCatalog: toolRegistry,
  })

  const sessionId = createSessionId('err-recover-session')
  await runtime.createSession({ sessionId })

  // 第一轮：失败
  const failRunId = await runtime.runTurn({
    sessionId,
    message: createUserMessage('msg-fail', 'do something'),
  })
  const failOutcome = await collectRuntimeOutcome(failRunId, runtime)
  expect(failOutcome.error).toBeDefined()
  await waitForRunStatus(runtime, failRunId, 'failed')

  // 第二轮：同一 runtime 实例恢复
  const successRunId = await runtime.runTurn({
    sessionId,
    message: createUserMessage('msg-recover', 'recover'),
  })
  const successEvents = await collectRuntimeEvents(successRunId, runtime)

  assertRunCompleted(successEvents)
})
```

- [ ] **Step 2: 检查 createMockTool 是否支持 handler 参数**

Run: `cd packages/runtime && grep -n 'createMockTool' src/__tests__/helpers/runtime-test-utils.ts`

如果不支持 `handler` 参数，需要直接使用 `ToolRegistry.registerTool` 注册自定义工具，不依赖 `createMockTool`：

```typescript
it('run 失败后同 session 可发起新 runTurn', async () => {
  const snapshotStore = new InMemorySnapshotStore()
  let callCount = 0
  const toolRegistry = new ToolRegistry().registerTool({
    spec: { name: 'conditional', description: 'Conditional', parameters: { type: 'object' } },
    execute: async () => {
      callCount++
      if (callCount === 1) {
        throw new Error('first-run-error')
      }
      return 'ok'
    },
  })

  const runtime = createSessionRuntime({
    deepagents: {
      model: fakeModel()
        .respondWithTools([{ name: 'conditional', args: {}, id: 'tool-fail-1' }])
        .respond(new AIMessage('recovered')),
    },
    snapshotStore,
    toolCatalog: toolRegistry,
  })

  const sessionId = createSessionId('err-recover-session')
  await runtime.createSession({ sessionId })

  // 第一轮：失败
  const failRunId = await runtime.runTurn({
    sessionId,
    message: createUserMessage('msg-fail', 'do something'),
  })
  const failOutcome = await collectRuntimeOutcome(failRunId, runtime)
  expect(failOutcome.error).toBeDefined()
  await waitForRunStatus(runtime, failRunId, 'failed')

  // 第二轮：同一 runtime 实例恢复
  const successRunId = await runtime.runTurn({
    sessionId,
    message: createUserMessage('msg-recover', 'recover'),
  })
  const successEvents = await collectRuntimeEvents(successRunId, runtime)

  assertRunCompleted(successEvents)
})
```

- [ ] **Step 3: 运行测试验证通过**

Run: `cd packages/runtime && pnpm vitest run src/__tests__/suite/error-recovery.test.ts`
Expected: 所有测试 PASS

- [ ] **Step 4: 提交**

```bash
git add packages/runtime/src/__tests__/suite/error-recovery.test.ts
git commit -m "test(runtime): 修正 error-recovery 恢复测试使用同一 runtime 实例"
```

---

### Task 4: tool-catalog.test.ts — 补齐错误路径和策略矩阵

**Files:**
- Modify: `packages/runtime/src/__tests__/tool-catalog.test.ts`

- [ ] **Step 1: 补齐 executeTool 错误路径、createCatalog 变体、ensureToolAllowed 完整矩阵**

在文件末尾 `describe('ToolRegistry')` 块中追加：

```typescript
import { PolicyError, ToolError, createRunId, createSessionId } from '@tianji/shared'
// （确保 PolicyError 已导入）

it('executeTool throws TOOL_NOT_FOUND for unregistered tool', async () => {
  const registry = new ToolRegistry()
  const catalog = registry.createCatalog()
  const context = {
    sessionId: createSessionId('s-1'),
    runId: createRunId('r-1'),
    toolCallId: 'call-1',
  }

  await expect(
    catalog.executeTool(
      { toolCallId: 'call-1', toolName: 'ghost', args: {} },
      context
    )
  ).rejects.toThrow(ToolError)

  await expect(
    catalog.executeTool(
      { toolCallId: 'call-1', toolName: 'ghost', args: {} },
      context
    )
  ).rejects.toThrow('ghost')
})

it('hasTool returns false for unregistered tool', () => {
  const registry = new ToolRegistry()
  expect(registry.hasTool('nonexistent')).toBe(false)
})

it('getTool returns undefined for unregistered tool', () => {
  const registry = new ToolRegistry()
  expect(registry.getTool('nonexistent')).toBeUndefined()
})

it('createCatalog with toolNames filters to specified tools', () => {
  const registry = new ToolRegistry()
    .registerTool({
      spec: { name: 'tool_a', description: 'A', parameters: { type: 'object' } },
      execute: async () => null,
    })
    .registerTool({
      spec: { name: 'tool_b', description: 'B', parameters: { type: 'object' } },
      execute: async () => null,
    })

  const catalog = registry.createCatalog(['tool_a'])

  expect(catalog.hasTool('tool_a')).toBe(true)
  expect(catalog.hasTool('tool_b')).toBe(false)
})

it('createCatalog with unknown toolName throws TOOL_NOT_FOUND', () => {
  const registry = new ToolRegistry()

  expect(() => registry.createCatalog(['ghost'])).toThrow(ToolError)
})

it('listTools returns all registered tools', () => {
  const registry = new ToolRegistry()
    .registerTool({
      spec: { name: 'tool_x', description: 'X', parameters: { type: 'object' } },
      execute: async () => null,
    })
    .registerTool({
      spec: { name: 'tool_y', description: 'Y', parameters: { type: 'object' } },
      execute: async () => null,
    })

  const tools = registry.listTools()
  expect(tools.map((t) => t.spec.name)).toEqual(['tool_x', 'tool_y'])
})

it('getToolSpecs returns specs for all registered tools', () => {
  const registry = new ToolRegistry()
    .registerTool({
      spec: { name: 'tool_z', description: 'Z', parameters: { type: 'object' } },
      execute: async () => null,
    })

  const specs = registry.getToolSpecs()
  expect(specs).toEqual([{ name: 'tool_z', description: 'Z', parameters: { type: 'object' } }])
})

describe('ensureToolAllowed', () => {
  const makeToolDef = (sideEffect?: 'none' | 'idempotent' | 'destructive') => ({
    spec: { name: 'test-tool', description: 'Test', parameters: { type: 'object' as const } },
    execute: async () => null,
    sideEffect,
  })

  it('allows destructive tool when allowDestructive is true', () => {
    expect(() => ensureToolAllowed(makeToolDef('destructive'), true)).not.toThrow()
  })

  it('blocks destructive tool when allowDestructive is false', () => {
    expect(() => ensureToolAllowed(makeToolDef('destructive'), false)).toThrow(PolicyError)
  })

  it('allows idempotent tool regardless of allowDestructive', () => {
    expect(() => ensureToolAllowed(makeToolDef('idempotent'), false)).not.toThrow()
    expect(() => ensureToolAllowed(makeToolDef('idempotent'), true)).not.toThrow()
  })

  it('allows none sideEffect tool regardless of allowDestructive', () => {
    expect(() => ensureToolAllowed(makeToolDef('none'), false)).not.toThrow()
    expect(() => ensureToolAllowed(makeToolDef('none'), true)).not.toThrow()
  })

  it('allows tool with undefined sideEffect regardless of allowDestructive', () => {
    expect(() => ensureToolAllowed(makeToolDef(undefined), false)).not.toThrow()
    expect(() => ensureToolAllowed(makeToolDef(undefined), true)).not.toThrow()
  })
})
```

- [ ] **Step 2: 确保顶部导入包含 PolicyError**

将第 1 行的导入改为：

```typescript
import { PolicyError, ToolError, createRunId, createSessionId } from '@tianji/shared'
```

- [ ] **Step 3: 运行测试验证通过**

Run: `cd packages/runtime && pnpm vitest run src/__tests__/tool-catalog.test.ts`
Expected: 所有测试 PASS

- [ ] **Step 4: 提交**

```bash
git add packages/runtime/src/__tests__/tool-catalog.test.ts
git commit -m "test(runtime): 补齐 tool-catalog 错误路径、createCatalog 变体和 ensureToolAllowed 策略矩阵"
```

---

### Task 5: 批量修复 try/catch 反模式

**Files:**
- Modify: `packages/runtime/src/__tests__/runtime-deepagents-bootstrap.test.ts`
- Modify: `packages/runtime/src/__tests__/runtime-engine-selection.test.ts`

策略：删除冗余的 try/catch 块，保留单次 `expect(...).toThrow()` 断言，如需验证错误属性则用链式 matcher。

- [ ] **Step 1: 修复 runtime-deepagents-bootstrap.test.ts**

将第 67-91 行的 "fails fast when model is missing" 替换为：

```typescript
it('fails fast when model is missing', () => {
  const deepagents = {} as SessionRuntimeDeepagentsConfig

  expect.assertions(3)

  try {
    createSessionRuntime({
      engine: 'deepagents',
      deepagents,
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry(),
    })
  } catch (error) {
    expect(error).toBeInstanceOf(TianjiError)
    expect((error as TianjiError).code).toBe('INVALID_DEEPAGENTS_CONFIG')
    expect((error as TianjiError).message).toContain('deepagents.model')
  }
})
```

- [ ] **Step 2: 修复 runtime-engine-selection.test.ts**

对第 56-65 行 "rejects explicit legacy engine after final removal"：

```typescript
it('rejects explicit legacy engine after final removal', () => {
  expect.assertions(2)

  try {
    createRuntimeWithLegacyEngineOverride()
  } catch (error) {
    expect(error).toBeInstanceOf(TianjiError)
    expect((error as TianjiError).code).toBe('UNSUPPORTED_RUNTIME_ENGINE')
  }
})
```

对第 92-141 行 "rejects runTurn for sessions bound to the legacy engine"：

```typescript
it('rejects runTurn for sessions bound to the legacy engine', async () => {
  expect.assertions(3)

  const store = new InMemorySnapshotStore()
  const legacySession: SessionSnapshot = {
    sessionId: createSessionId('session-legacy-boundary'),
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {
      runtime: { engine: 'legacy' },
    },
  }
  await store.saveSession(legacySession)

  const runtime = createSessionRuntime({
    deepagents: {
      model: 'openai:gpt-5.1',
    },
    snapshotStore: store,
    toolCatalog: new ToolRegistry(),
  })

  try {
    await runtime.runTurn({
      sessionId: legacySession.sessionId,
      message: {
        id: 'msg-1',
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        createdAt: Date.now(),
      },
    })
  } catch (error) {
    expect(error).toBeInstanceOf(TianjiError)
    expect((error as TianjiError).code).toBe('SESSION_ENGINE_MISMATCH')
    expect((error as TianjiError).message).toContain('legacy')
  }
})
```

对第 143-188 行 "rejects resumeRun when the stored run is bound to the legacy engine"：

```typescript
it('rejects resumeRun when the stored run is bound to the legacy engine', async () => {
  expect.assertions(3)

  const store = new InMemorySnapshotStore()
  const session: SessionSnapshot = {
    sessionId: createSessionId('session-resume-engine-mismatch'),
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {
      runtime: { engine: 'deepagents' },
    },
  }
  await store.saveSession(session)
  const cancelledRunId = createRunId('run-cancelled-legacy')
  const previousRun: RunSnapshot = {
    runId: cancelledRunId,
    sessionId: session.sessionId,
    status: 'cancelled',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    pendingOperations: [],
    metadata: {
      runtime: { engine: 'legacy' },
    },
  }
  await store.saveRun(previousRun)

  const runtime = createSessionRuntime({
    deepagents: {
      model: 'openai:gpt-5.1',
    },
    snapshotStore: store,
    toolCatalog: new ToolRegistry(),
  })

  try {
    await runtime.resumeRun({ runId: cancelledRunId })
  } catch (error) {
    expect(error).toBeInstanceOf(TianjiError)
    expect((error as TianjiError).code).toBe('SESSION_ENGINE_MISMATCH')
    expect((error as TianjiError).message).toContain('legacy')
  }
})
```

对第 190-235 行 "rejects resumeRun when historical cancelled runs have no runtime engine metadata"：

```typescript
it('rejects resumeRun when historical cancelled runs have no runtime engine metadata', async () => {
  expect.assertions(3)

  const store = new InMemorySnapshotStore()
  const session: SessionSnapshot = {
    sessionId: createSessionId('session-resume-missing-engine'),
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {
      runtime: { engine: 'deepagents' },
    },
  }
  await store.saveSession(session)
  const cancelledRunId = createRunId('run-cancelled-missing-engine')
  const previousRun: RunSnapshot = {
    runId: cancelledRunId,
    sessionId: session.sessionId,
    status: 'cancelled',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    pendingOperations: [],
    metadata: {
      resumedFromRunId: createRunId('previous-run'),
    },
  }
  await store.saveRun(previousRun)

  const runtime = createSessionRuntime({
    deepagents: {
      model: 'openai:gpt-5.1',
    },
    snapshotStore: store,
    toolCatalog: new ToolRegistry(),
  })

  try {
    await runtime.resumeRun({ runId: cancelledRunId })
  } catch (error) {
    expect(error).toBeInstanceOf(TianjiError)
    expect((error as TianjiError).code).toBe('SESSION_ENGINE_MISMATCH')
    expect((error as TianjiError).message).toContain('legacy')
  }
})
```

- [ ] **Step 3: 运行测试验证通过**

Run: `cd packages/runtime && pnpm vitest run src/__tests__/runtime-deepagents-bootstrap.test.ts src/__tests__/runtime-engine-selection.test.ts`
Expected: 所有测试 PASS

- [ ] **Step 4: 提交**

```bash
git add packages/runtime/src/__tests__/runtime-deepagents-bootstrap.test.ts packages/runtime/src/__tests__/runtime-engine-selection.test.ts
git commit -m "test(runtime): 为 try/catch 错误断言添加 expect.assertions 防止静默跳过"
```

---

### Task 6: shared 类型见证测试清理

**Files:**
- Modify: `packages/shared/src/__tests__/artifact.test.ts`
- Modify: `packages/shared/src/__tests__/delta.test.ts`
- Modify: `packages/shared/src/__tests__/message.test.ts`
- Modify: `packages/shared/src/__tests__/tool.test.ts`
- Modify: `packages/shared/src/__tests__/identifiers.test.ts`

策略：
- `artifact.test.ts`、`delta.test.ts`、`message.test.ts`、`tool.test.ts` 是纯类型定义文件的运行时见证测试，全部替换为最小化的 `expectTypeOf` 编译期检查。
- `identifiers.test.ts` 的 branded type isolation 测试（158-176 行）修正为 `@ts-expect-error` 验证。

- [ ] **Step 1: 替换 artifact.test.ts**

```typescript
import { expectTypeOf } from 'vitest'
import type { Artifact, ArtifactType } from '../artifact.js'

describe('artifact type contracts', () => {
  it('ArtifactType is a string union of the four artifact kinds', () => {
    expectTypeOf<ArtifactType>().toEqualTypeOf<'code-snippet' | 'file-change' | 'image' | 'structured-result'>()
  })

  it('Artifact requires id, type, name, content, createdAt', () => {
    expectTypeOf<Artifact>().toHaveProperty('id')
    expectTypeOf<Artifact>().toHaveProperty('type')
    expectTypeOf<Artifact>().toHaveProperty('name')
    expectTypeOf<Artifact>().toHaveProperty('content')
    expectTypeOf<Artifact>().toHaveProperty('createdAt')
  })
})
```

- [ ] **Step 2: 替换 delta.test.ts**

```typescript
import { expectTypeOf } from 'vitest'
import type {
  Delta,
  DeltaOp,
  MessageDelta,
  MessageDeltaChannel,
  ToolProgressChannel,
  ToolProgressDelta,
} from '../delta.js'

describe('delta type contracts', () => {
  it('DeltaOp is a string union', () => {
    expectTypeOf<DeltaOp>().toEqualTypeOf<'append' | 'replace' | 'complete'>()
  })

  it('MessageDeltaChannel is a string union', () => {
    expectTypeOf<MessageDeltaChannel>().toEqualTypeOf<'text' | 'thinking'>()
  })

  it('ToolProgressChannel is a string union', () => {
    expectTypeOf<ToolProgressChannel>().toEqualTypeOf<'stdout' | 'stderr' | 'progress' | 'result'>()
  })

  it('Delta is a union of MessageDelta and ToolProgressDelta', () => {
    expectTypeOf<MessageDelta>().toMatchTypeOf<Delta>()
    expectTypeOf<ToolProgressDelta>().toMatchTypeOf<Delta>()
  })

  it('MessageDelta has messageId, ToolProgressDelta has toolCallId', () => {
    expectTypeOf<MessageDelta>().toHaveProperty('messageId')
    expectTypeOf<ToolProgressDelta>().toHaveProperty('toolCallId')
  })
})
```

- [ ] **Step 3: 替换 message.test.ts**

```typescript
import { expectTypeOf } from 'vitest'
import type {
  AppMessage,
  ImageContent,
  MessagePart,
  MessageRole,
  TextContent,
  ThinkingContent,
  ToolCall,
} from '../message.js'

describe('message type contracts', () => {
  it('MessageRole is a string union', () => {
    expectTypeOf<MessageRole>().toEqualTypeOf<'user' | 'assistant' | 'system'>()
  })

  it('MessagePart is a union of content types', () => {
    expectTypeOf<TextContent>().toMatchTypeOf<MessagePart>()
    expectTypeOf<ThinkingContent>().toMatchTypeOf<MessagePart>()
    expectTypeOf<ImageContent>().toMatchTypeOf<MessagePart>()
    expectTypeOf<ToolCall>().toMatchTypeOf<MessagePart>()
  })

  it('AppMessage requires id, role, content, createdAt', () => {
    expectTypeOf<AppMessage>().toHaveProperty('id')
    expectTypeOf<AppMessage>().toHaveProperty('role')
    expectTypeOf<AppMessage>().toHaveProperty('content')
    expectTypeOf<AppMessage>().toHaveProperty('createdAt')
  })
})
```

- [ ] **Step 4: 替换 tool.test.ts**

```typescript
import { expectTypeOf } from 'vitest'
import type { ToolInvocation, ToolResult, ToolSpec } from '../tool.js'

describe('tool type contracts', () => {
  it('ToolSpec requires name, description, parameters', () => {
    expectTypeOf<ToolSpec>().toHaveProperty('name')
    expectTypeOf<ToolSpec>().toHaveProperty('description')
    expectTypeOf<ToolSpec>().toHaveProperty('parameters')
  })

  it('ToolInvocation requires toolCallId, toolName, args', () => {
    expectTypeOf<ToolInvocation>().toHaveProperty('toolCallId')
    expectTypeOf<ToolInvocation>().toHaveProperty('toolName')
    expectTypeOf<ToolInvocation>().toHaveProperty('args')
  })

  it('ToolResult requires toolCallId and toolName', () => {
    expectTypeOf<ToolResult>().toHaveProperty('toolCallId')
    expectTypeOf<ToolResult>().toHaveProperty('toolName')
  })
})
```

- [ ] **Step 5: 修正 identifiers.test.ts 的 branded type isolation**

替换第 158-176 行：

```typescript
describe('branded type isolation', () => {
  it('SessionId is not directly assignable to ThreadId', () => {
    const sessionId = createSessionId('session-123')
    // @ts-expect-error -- branded types prevent cross-assignment
    const _threadId: ThreadId = sessionId
  })

  it('ThreadId is not directly assignable to RunId', () => {
    const threadId = createThreadId('thread-456')
    // @ts-expect-error -- branded types prevent cross-assignment
    const _runId: RunId = threadId
  })

  it('RunId is not directly assignable to SessionId', () => {
    const runId = createRunId('run-789')
    // @ts-expect-error -- branded types prevent cross-assignment
    const _sessionId: SessionId = runId
  })
})
```

- [ ] **Step 6: 运行测试验证通过**

Run: `cd packages/shared && pnpm vitest run src/__tests__/artifact.test.ts src/__tests__/delta.test.ts src/__tests__/message.test.ts src/__tests__/tool.test.ts src/__tests__/identifiers.test.ts`
Expected: 所有测试 PASS

- [ ] **Step 7: 运行 pnpm check 确保类型检查通过**

Run: `pnpm check`
Expected: 无错误

- [ ] **Step 8: 提交**

```bash
git add packages/shared/src/__tests__/artifact.test.ts packages/shared/src/__tests__/delta.test.ts packages/shared/src/__tests__/message.test.ts packages/shared/src/__tests__/tool.test.ts packages/shared/src/__tests__/identifiers.test.ts
git commit -m "test(shared): 将类型见证测试替换为 expectTypeOf 编译期检查，修正 branded type isolation"
```
