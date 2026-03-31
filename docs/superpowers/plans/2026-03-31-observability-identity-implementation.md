# Observability Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 runtime 的新建、resume、retry/replay 执行链路中补齐 `parentRunId` 与 `triggerType`，让单次 run 与恢复链条可以稳定查询，并把该语义落到快照、事件和日志边界上。

**Architecture:** 方案沿用现有 `sessionId + runId` 模型，不引入 `traceId`。最小改动路径是先把标识语义固化在 `@tianji/shared` 的 `RunSnapshot` 与 `RuntimeEvent` 合同，再由 `@tianji/runtime` 在 `runTurn` / `resumeRun` 的入口统一写入，并通过 `ObserverLogger` 在 run 生命周期节点输出带结构化 `data` 的日志。

**Tech Stack:** TypeScript、pnpm workspace、Vitest、deepagents runtime、@tianji/shared、@tianji/observer

---

## 文件结构与职责

- `packages/shared/src/snapshot.ts`：扩展 `RunSnapshot` 持久化合同，声明 `parentRunId` 与 `triggerType` 的稳定字段。
- `packages/shared/src/events.ts`：扩展 run 级事件结构，让 `run.started` / `run.completed` / `run.failed` / `run.cancelled` 携带 run 来源语义。
- `packages/shared/src/__tests__/snapshot.test.ts`：锁定新增快照字段的类型和序列化预期。
- `packages/shared/src/__tests__/events.test.ts`：锁定新增事件字段的联合类型契约。
- `packages/runtime/src/runtime.ts`：在 `runTurn` 与 `resumeRun` 统一生成 `triggerType`、`parentRunId`，写入 snapshot、event 与 observer logger。
- `packages/runtime/src/__tests__/runtime-cancel-resume.test.ts`：验证 replay resume 和 HITL resume 都会生成新 `runId`，并正确记录 `parentRunId` 与 `triggerType: 'resume'`。
- `packages/runtime/src/__tests__/runtime.test.ts`：补 runTurn 的 `'new'` 路径契约，避免后续只修恢复链路漏掉新建 run。
- `packages/runtime/README.md`：更新 runtime 对外文档，说明 `parentRunId` / `triggerType` 的含义与日志约束。

## 实施约束

- 严格遵守 `docs/superpowers/specs/2026-03-31-observability-identity-design.md`，不引入 `traceId`、metrics 或 tracing exporter。
- 保持 JSONL 顶层字段结构不变；新增信息只能放在日志 entry 的 `data` 中。
- `resumeRun` 继续生成新的 `runId`，禁止复用旧 run。
- 如果实现过程中发现仓库当前没有公开 `retry` API，不要臆造新 API；只在现有 `resume/replay` 语义上预留 `triggerType` 枚举能力，并在计划中明确标注真实落点。
- 若进行了代码变更，结束前必须在仓库根目录执行 `pnpm check`，并修复全部错误、警告和信息。
- 本计划默认不运行测试；若执行阶段修改测试，只能在对应 package 根目录运行。

### Task 1: 固化 shared 标识合同

**Files:**
- Modify: `packages/shared/src/snapshot.ts`
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/snapshot.test.ts`
- Test: `packages/shared/src/__tests__/events.test.ts`

- [ ] **Step 1: 先写 shared 合同失败测试，锁定新增字段与枚举**

```ts
import type { RunId } from '../identifiers.js'
import type { RunSnapshot, RunStatus, RunTriggerType } from '../snapshot.js'

const parentRunId = 'run_parent' as RunId

const triggerTypes: RunTriggerType[] = ['new', 'resume', 'retry', 'replay']
const statuses: RunStatus[] = ['running', 'completed', 'failed', 'cancelled']

const snapshot: RunSnapshot = {
  runId: 'run_child' as RunId,
  sessionId: 'session_1' as never,
  status: 'running',
  triggerType: 'resume',
  parentRunId,
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  pendingOperations: [],
}

expect(triggerTypes).toEqual(['new', 'resume', 'retry', 'replay'])
expect(statuses).toContain('cancelled')
expect(snapshot.parentRunId).toBe(parentRunId)
expect(snapshot.triggerType).toBe('resume')
```

```ts
import type {
  RunCancelledEvent,
  RunCompletedEvent,
  RunFailedEvent,
  RunStartedEvent,
} from '../events.js'

declare const started: RunStartedEvent
declare const completed: RunCompletedEvent
declare const failed: RunFailedEvent
declare const cancelled: RunCancelledEvent

void started.triggerType
void completed.triggerType
void failed.triggerType
void cancelled.triggerType
void completed.parentRunId
void failed.parentRunId
void cancelled.parentRunId
```

- [ ] **Step 2: 运行 shared 测试确认当前失败**

Run: `pnpm --filter @tianji/shared test -- --run src/__tests__/snapshot.test.ts src/__tests__/events.test.ts`
Expected: FAIL，报错缺少 `RunTriggerType`、`triggerType` 或 `parentRunId` 字段。

- [ ] **Step 3: 写最小 shared 类型实现**

```ts
export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export type RunTriggerType = 'new' | 'resume' | 'retry' | 'replay'

export interface RunSnapshot {
  readonly runId: RunId
  readonly sessionId: SessionId
  readonly status: RunStatus
  readonly triggerType: RunTriggerType
  readonly parentRunId?: RunId
  readonly messages: AppMessage[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly cancelPoint?: string
  readonly pendingOperations: PendingOperation[]
  readonly resumeHint?: ResumeHint
  readonly workflowState?: unknown
  readonly policy?: ExecutionPolicy
  readonly metadata?: Record<string, unknown>
}
```

```ts
import type { RunId, SessionId } from './identifiers.js'
import type { RunTriggerType } from './snapshot.js'

interface RunLifecycleEventFields {
  readonly runId: RunId
  readonly sessionId: SessionId
  readonly triggerType: RunTriggerType
  readonly parentRunId?: RunId
  readonly timestamp: number
}

export interface RunStartedEvent extends RunLifecycleEventFields {
  readonly type: 'run.started'
}

export interface RunCompletedEvent extends RunLifecycleEventFields {
  readonly type: 'run.completed'
}

export interface RunFailedEvent extends RunLifecycleEventFields {
  readonly type: 'run.failed'
  readonly error: TianjiError
}

export interface RunCancelledEvent extends RunLifecycleEventFields {
  readonly type: 'run.cancelled'
}
```

```ts
export type { RunStatus, RunTriggerType, RunSnapshot } from './snapshot.js'
```

- [ ] **Step 4: 运行 shared 测试确认合同通过**

Run: `pnpm --filter @tianji/shared test -- --run src/__tests__/snapshot.test.ts src/__tests__/events.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 shared 合同改动**

```bash
git add packages/shared/src/snapshot.ts packages/shared/src/events.ts packages/shared/src/index.ts packages/shared/src/__tests__/snapshot.test.ts packages/shared/src/__tests__/events.test.ts
git commit -m "feat(shared): add observability run lineage fields"
```

### Task 2: 在 runtime 写入 run 来源语义并输出 observer 日志

**Files:**
- Modify: `packages/runtime/src/runtime.ts`
- Test: `packages/runtime/src/__tests__/runtime.test.ts`
- Test: `packages/runtime/src/__tests__/runtime-cancel-resume.test.ts`

- [ ] **Step 1: 先写 runtime 失败测试，覆盖新建 run 与 resume run 的标识链**

```ts
it('marks new runs with triggerType new and no parentRunId', async () => {
  const runtime = createSessionRuntime({
    deepagents: { model: fakeModel().respond(new AIMessage('ok')) },
  })
  const session = await runtime.createSession({
    sessionId: createSessionId('session-runtime-trigger-new'),
  })

  const runId = await runtime.runTurn({
    sessionId: session.sessionId,
    message: createUserMessage('msg-runtime-trigger-new', 'hello'),
  })

  const events = await collectRuntimeEvents(runId, runtime)
  const run = await waitForRunStatus(runtime, runId, 'completed')

  expect(run.triggerType).toBe('new')
  expect(run.parentRunId).toBeUndefined()
  expect(events[0]).toMatchObject({
    type: 'run.started',
    runId,
    triggerType: 'new',
    parentRunId: undefined,
  })
})
```

```ts
it('records parentRunId and triggerType when resuming a cancelled run', async () => {
  const logger = createObserverLogger({ sinks: [createMemorySink()] })
  const snapshotStore = new InMemorySnapshotStore()

  const cancellationRuntime = createSessionRuntime({
    deepagents: {
      model: fakeModel().respondWithTools([{ name: 'lookup', args: { city: 'Shanghai' }, id: 'tool-replay' }]),
    },
    snapshotStore,
    toolCatalog,
    logger,
  })

  const resumeRuntime = createSessionRuntime({
    deepagents: { model: fakeModel().respond(new AIMessage('resumed answer')) },
    snapshotStore,
    toolCatalog,
    logger,
  })

  const resumedRunId = await resumeRuntime.resumeRun({ runId: cancelledRunId })
  const resumedRun = await waitForRunStatus(resumeRuntime, resumedRunId, 'completed')
  const resumedEvents = await collectRuntimeEvents(resumedRunId, resumeRuntime)

  expect(resumedRun.triggerType).toBe('resume')
  expect(resumedRun.parentRunId).toBe(cancelledRunId)
  expect(resumedEvents[0]).toMatchObject({
    type: 'run.started',
    runId: resumedRunId,
    sessionId: session.sessionId,
    triggerType: 'resume',
    parentRunId: cancelledRunId,
  })

  expect(memorySink.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        data: expect.objectContaining({
          sessionId: session.sessionId,
          runId: resumedRunId,
          parentRunId: cancelledRunId,
          triggerType: 'resume',
        }),
      }),
    ])
  )
})
```

- [ ] **Step 2: 运行 runtime 测试确认当前失败**

Run: `pnpm --filter @tianji/runtime test -- --run src/__tests__/runtime.test.ts src/__tests__/runtime-cancel-resume.test.ts`
Expected: FAIL，当前 `RunSnapshot`、`RuntimeEvent` 和 observer 日志都还没有 `triggerType` / `parentRunId`。

- [ ] **Step 3: 在 runtime 入口统一补齐 triggerType、parentRunId 与日志输出**

```ts
import type { ObserverLogger } from '@tianji/observer'
import {
  type RunId,
  type RunSnapshot,
  type RunTriggerType,
  type RuntimeEvent,
  type SessionId,
} from '@tianji/shared'

interface ExecuteRunInput {
  readonly runId: RunId
  readonly sessionSnapshot: SessionSnapshot
  readonly messages: readonly AppMessage[]
  readonly policy: ExecutionPolicy
  readonly abortSignal?: AbortSignal
  readonly systemPrompt?: string
  readonly config?: LlmGenerationConfig
  readonly triggerType: RunTriggerType
  readonly parentRunId?: RunId
  readonly sourceRunId?: RunId
  readonly threadId?: string
  readonly checkpointId?: string
  readonly resumeValue?: unknown
}
```

```ts
const runId = createRunId(`run_${randomUUID()}`)
await this.startRun({
  runId,
  sessionSnapshot: nextSessionSnapshot,
  messages: nextSessionSnapshot.messages,
  policy: nextPolicy,
  abortSignal: options.abortSignal,
  systemPrompt: options.systemPrompt,
  config: options.config,
  triggerType: 'new',
})
```

```ts
const resumedRunId = createRunId(`run_${randomUUID()}`)
await this.startRun({
  runId: resumedRunId,
  sessionSnapshot,
  messages: previousRun.messages,
  policy: previousRun.policy ?? sessionSnapshot.policy ?? DEFAULT_EXECUTION_POLICY,
  abortSignal: options.abortSignal,
  systemPrompt: options.systemPrompt ?? readStoredSystemPrompt(previousRun.metadata),
  config: options.config ?? readStoredGenerationConfig(previousRun.metadata),
  triggerType: 'resume',
  parentRunId: previousRun.runId,
  sourceRunId: previousRun.runId,
  threadId: runtimeMetadata?.threadId ?? sessionSnapshot.sessionId,
  checkpointId: canCheckpointResume ? runtimeMetadata?.checkpointId : undefined,
  resumeValue: canCheckpointResume ? options.resumeValue : undefined,
})
```

```ts
const runSnapshot: RunSnapshot = {
  runId: input.runId,
  sessionId: input.sessionSnapshot.sessionId,
  status: 'running',
  triggerType: input.triggerType,
  parentRunId: input.parentRunId,
  messages: [...input.messages],
  createdAt: timestamp,
  updatedAt: timestamp,
  pendingOperations: [],
  policy: input.policy,
  metadata: writeRunRuntimeMetadata(
    {
      systemPrompt: input.systemPrompt,
      generationConfig: input.config,
      resumedFromRunId: input.sourceRunId,
    },
    {
      engine: this.engine,
      threadId: input.threadId ?? input.sessionSnapshot.sessionId,
      checkpointId: input.checkpointId,
    }
  ),
}
```

```ts
const lifecycleFields = {
  runId: activeRun.runId,
  sessionId: activeRun.sessionId,
  triggerType: runSnapshot.triggerType,
  parentRunId: runSnapshot.parentRunId,
  timestamp: Date.now(),
}

activeRun.events.push({
  type: 'run.started',
  ...lifecycleFields,
})
```

```ts
await this.options.logger?.info(['runtime', 'run'], 'run lifecycle', {
  sessionId: activeRun.sessionId,
  runId: activeRun.runId,
  ...(runSnapshot.parentRunId === undefined ? {} : { parentRunId: runSnapshot.parentRunId }),
  triggerType: runSnapshot.triggerType,
  status: 'started',
})
```

说明：
`run.completed`、`run.failed`、`run.cancelled` 事件和对应日志也要复用同一组 `triggerType` / `parentRunId` 字段，避免只有开始事件可查、失败日志不可查。

- [ ] **Step 4: 运行 runtime 测试确认恢复链路合同成立**

Run: `pnpm --filter @tianji/runtime test -- --run src/__tests__/runtime.test.ts src/__tests__/runtime-cancel-resume.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 runtime 标识链实现**

```bash
git add packages/runtime/src/runtime.ts packages/runtime/src/__tests__/runtime.test.ts packages/runtime/src/__tests__/runtime-cancel-resume.test.ts
git commit -m "feat(runtime): record run lineage for resume flows"
```

### Task 3: 更新 runtime 文档并完成仓库校验

**Files:**
- Modify: `packages/runtime/README.md`

- [ ] **Step 1: 更新 README，明确新标识字段与查询方式**

```md
- `RunSnapshot` 现在额外持有 `triggerType` 与可选 `parentRunId`，用于区分新建 run 与恢复 run。
- `run.started` / `run.completed` / `run.failed` / `run.cancelled` 事件都会携带 `sessionId`、`runId`、`triggerType`，恢复链路还会带 `parentRunId`。
- 如果注入了 `logger?: ObserverLogger`，runtime 会在 run 生命周期日志的 `data` 中写入这些字段，保证可直接按 `sessionId + runId` 检索。
```

- [ ] **Step 2: 运行仓库级静态检查**

Run: `pnpm check`
Expected: PASS，且无 error、warning、info 遗留。

- [ ] **Step 3: 提交文档与最终校验结果**

```bash
git add packages/runtime/README.md
git commit -m "docs(runtime): document run lineage observability fields"
```

## 自检

- spec coverage：已覆盖 `sessionId` / `runId` 既有语义保持不变、`parentRunId` 新增、resume 生成新 `runId`、runtime event 携带 `parentRunId + triggerType`、observer 日志写入 `data`、README 更新。
- gap note：spec 文本提到 `retry` / `replay`，但当前仓库公开 API 实际只有 `resumeRun`；计划通过 `RunTriggerType` 先把枚举合同预留完整，执行时只在真实存在的 `runTurn` / `resumeRun` 落地，避免平白造接口。
- placeholder scan：计划里没有 `TODO`、`TBD`、`similar to` 之类占位表述。
- type consistency：统一使用 `RunTriggerType`、`triggerType`、`parentRunId` 命名，runtime / shared / README 保持一致。

Plan complete and saved to `docs/superpowers/plans/2026-03-31-observability-identity-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
