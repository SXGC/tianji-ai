# Token Usage Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record token usage at both run and session levels, with logger output on run completion.

**Architecture:** Extract `usage_metadata` from LangChain's `on_chat_model_end` event in the deepagents engine, accumulate per-run, return in `DeepagentsRunResult`. Runtime writes usage into `RunSnapshot.metadata` and accumulates into `SessionSnapshot.metadata`. `logRunLifecycle` prints usage on `run.completed`.

**Tech Stack:** TypeScript, LangChain `@langchain/core` (AIMessage.usage_metadata), `@tianji/shared` snapshot types, `@tianji/observer` logger.

---

### Task 1: Add `TokenUsage` type to shared package

**Files:**
- Modify: `packages/shared/src/snapshot.ts:37-67`
- Test: `packages/shared/src/__tests__/snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/shared/src/__tests__/snapshot.test.ts`, add a test that imports and uses `TokenUsage`:

```typescript
import { describe, expect, it } from 'vitest'
import type { TokenUsage } from '../snapshot.js'

describe('TokenUsage', () => {
  it('is structurally compatible with expected shape', () => {
    const usage: TokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    }

    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(50)
    expect(usage.totalTokens).toBe(150)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm vitest run src/__tests__/snapshot.test.ts`
Expected: FAIL — `TokenUsage` is not exported from `../snapshot.js`

- [ ] **Step 3: Define `TokenUsage` and `addTokenUsage` in snapshot.ts**

Add to `packages/shared/src/snapshot.ts` (before the `SessionSnapshot` interface):

```typescript
/**
 * Token consumption counters for a single run or accumulated across a session.
 */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
}

/**
 * Accumulate two TokenUsage records by summing each field.
 *
 * @param base - Existing accumulated usage (or undefined for the first addition)
 * @param delta - New usage to add
 * @returns Merged TokenUsage with all fields summed
 */
export function addTokenUsage(base: TokenUsage | undefined, delta: TokenUsage): TokenUsage {
  return {
    inputTokens: (base?.inputTokens ?? 0) + delta.inputTokens,
    outputTokens: (base?.outputTokens ?? 0) + delta.outputTokens,
    totalTokens: (base?.totalTokens ?? 0) + delta.totalTokens,
  }
}
```

- [ ] **Step 4: Add `addTokenUsage` tests**

Extend the test file with `addTokenUsage` tests:

```typescript
import { type TokenUsage, addTokenUsage } from '../snapshot.js'

describe('addTokenUsage', () => {
  it('sums two TokenUsage records', () => {
    const base: TokenUsage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
    const delta: TokenUsage = { inputTokens: 200, outputTokens: 100, totalTokens: 300 }

    expect(addTokenUsage(base, delta)).toEqual({
      inputTokens: 300,
      outputTokens: 150,
      totalTokens: 450,
    })
  })

  it('treats undefined base as zero', () => {
    const delta: TokenUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }

    expect(addTokenUsage(undefined, delta)).toEqual(delta)
  })
})
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/shared && pnpm vitest run src/__tests__/snapshot.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/snapshot.ts packages/shared/src/__tests__/snapshot.test.ts
git commit -m "feat(shared): add TokenUsage type and addTokenUsage accumulator"
```

---

### Task 2: Extract usage_metadata in deepagents engine and return in RunResult

**Files:**
- Modify: `packages/runtime/src/engines/deepagents-engine.ts:102-107` (DeepagentsRunResult), `:118-127` (StreamLoopState), `:166-197` (processChatModelEndEvent), `:330-440` (executeDeepagentsRun)
- Test: `packages/runtime/src/__tests__/runtime-token-usage.test.ts` (new)

- [ ] **Step 1: Write the failing integration test**

Create `packages/runtime/src/__tests__/runtime-token-usage.test.ts`:

```typescript
/**
 * Token usage tracking 集成测试。
 *
 * 验证 deepagents engine 从 LangChain on_chat_model_end 事件中提取 usage_metadata，
 * 并在 RunSnapshot 和 SessionSnapshot 中持久化 usage 数据。
 */
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import type { TokenUsage } from '@tianji/shared'
import { createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createSessionRuntime } from '../runtime.js'
import { InMemorySnapshotStore } from '../snapshot-store.js'
import { ToolRegistry } from '../tool-catalog.js'
import {
  collectRuntimeEvents,
  createUserMessage,
  waitForRunStatus,
} from './helpers/runtime-test-utils.js'

describe('Token usage tracking', () => {
  it('records usage from a single-turn run into RunSnapshot and SessionSnapshot', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const aiMessage = new AIMessage({
      content: 'Hello!',
      usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    })

    const runtime = createSessionRuntime({
      deepagents: { model: fakeModel().respond(aiMessage) },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-usage-single'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-usage-1', 'hi'),
    })
    await collectRuntimeEvents(runId, runtime)
    const run = await waitForRunStatus(runtime, runId, 'completed')

    const runUsage = run.metadata?.usage as TokenUsage | undefined
    expect(runUsage).toBeDefined()
    expect(runUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    })

    const sessionSnapshot = await runtime.getSessionSnapshot(session.sessionId)
    const sessionUsage = sessionSnapshot?.metadata?.usage as TokenUsage | undefined
    expect(sessionUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    })
  })

  it('accumulates usage across multiple runs in the same session', async () => {
    const snapshotStore = new InMemorySnapshotStore()

    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respond(
            new AIMessage({
              content: 'First',
              usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
            })
          )
          .respond(
            new AIMessage({
              content: 'Second',
              usage_metadata: { input_tokens: 200, output_tokens: 80, total_tokens: 280 },
            })
          ),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-usage-multi'),
    })

    const runId1 = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-multi-1', 'first'),
    })
    await collectRuntimeEvents(runId1, runtime)
    await waitForRunStatus(runtime, runId1, 'completed')

    const runId2 = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-multi-2', 'second'),
    })
    await collectRuntimeEvents(runId2, runtime)
    await waitForRunStatus(runtime, runId2, 'completed')

    const run2 = await runtime.getRunSnapshot(runId2)
    expect(run2?.metadata?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      totalTokens: 280,
    })

    const sessionSnapshot = await runtime.getSessionSnapshot(session.sessionId)
    expect(sessionSnapshot?.metadata?.usage).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      totalTokens: 430,
    })
  })

  it('records zero usage when model does not provide usage_metadata', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage({ content: 'No metadata' })),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-usage-none'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-no-usage', 'hi'),
    })
    await collectRuntimeEvents(runId, runtime)
    const run = await waitForRunStatus(runtime, runId, 'completed')

    expect(run.metadata?.usage).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/runtime && pnpm vitest run src/__tests__/runtime-token-usage.test.ts`
Expected: FAIL — `run.metadata?.usage` is `undefined` (not yet implemented)

- [ ] **Step 3: Add usage accumulator to StreamLoopState**

In `packages/runtime/src/engines/deepagents-engine.ts`, import `TokenUsage` and `addTokenUsage`:

```typescript
import {
  type AppMessage,
  CancelledError,
  type ExecutionPolicy,
  type MessagePart,
  type MessageRole,
  type RunId,
  type RunSnapshot,
  type RuntimeEvent,
  type SessionId,
  TianjiError,
  TimeoutError,
  type TokenUsage,
  ToolError,
  type ToolInvocation,
  addTokenUsage,
} from '@tianji/shared'
```

Add a `usage` field to `StreamLoopState`:

```typescript
interface StreamLoopState {
  readonly messageId: string
  readonly messageStartedAt: number
  readonly observedToolCalls: DeepagentsPendingToolCall[]
  readonly turnMessages: AppMessage[]
  readonly builtinToolInvocations: Map<string, ToolInvocation>
  currentThinking: string
  currentText: string
  usage: TokenUsage | undefined
}
```

- [ ] **Step 4: Extract usage_metadata in processChatModelEndEvent**

In the `processChatModelEndEvent` function, add usage extraction after `registerObservedToolCalls`:

```typescript
function processChatModelEndEvent(state: StreamLoopState, event: DeepagentsAgentEvent): void {
  registerObservedToolCalls(event.data?.output, state.observedToolCalls)

  // 从 AIMessage.usage_metadata 提取 token 用量并累加到 run 级别计数器。
  const usageMetadata = readUsageMetadata(event.data?.output)
  if (usageMetadata !== undefined) {
    state.usage = addTokenUsage(state.usage, usageMetadata)
  }

  const parts: MessagePart[] = []
  // ... (rest of existing code unchanged)
```

Add a helper function to safely extract `usage_metadata`:

```typescript
/**
 * 从 LangChain AIMessage 的 usage_metadata 字段安全提取 token 用量。
 * LangChain 的 on_chat_model_end 事件中 data.output 是一个 AIMessage 实例，
 * 其 usage_metadata 包含 input_tokens、output_tokens、total_tokens。
 */
function readUsageMetadata(output: unknown): TokenUsage | undefined {
  if (typeof output !== 'object' || output === null) {
    return undefined
  }

  const candidate = output as { usage_metadata?: unknown }
  const metadata = candidate.usage_metadata

  if (typeof metadata !== 'object' || metadata === null) {
    return undefined
  }

  const typed = metadata as {
    input_tokens?: unknown
    output_tokens?: unknown
    total_tokens?: unknown
  }

  if (
    typeof typed.input_tokens !== 'number' ||
    typeof typed.output_tokens !== 'number' ||
    typeof typed.total_tokens !== 'number'
  ) {
    return undefined
  }

  return {
    inputTokens: typed.input_tokens,
    outputTokens: typed.output_tokens,
    totalTokens: typed.total_tokens,
  }
}
```

- [ ] **Step 5: Add usage to DeepagentsRunResult and return it**

Update `DeepagentsRunResult`:

```typescript
export interface DeepagentsRunResult {
  readonly turnMessages: AppMessage[]
  readonly threadId: string
  readonly checkpointId?: string
  readonly interrupts?: readonly DeepagentsInterruptRecord[]
  readonly usage?: TokenUsage
}
```

In `executeDeepagentsRun`, initialize the loop state with `usage: undefined`:

```typescript
  const loopState: StreamLoopState = {
    messageId,
    messageStartedAt,
    observedToolCalls,
    turnMessages,
    builtinToolInvocations,
    currentThinking: '',
    currentText: '',
    usage: undefined,
  }
```

Update both return statements in `executeDeepagentsRun` to include `usage: loopState.usage`:

For the interrupt path (around line 408):
```typescript
    return {
      turnMessages,
      threadId: stateMetadata.threadId,
      checkpointId: stateMetadata.checkpointId,
      interrupts: stateMetadata.interrupts,
      usage: loopState.usage,
    }
```

For the normal completion path (around line 435):
```typescript
  return {
    turnMessages,
    threadId: stateMetadata?.threadId ?? threadId,
    checkpointId: stateMetadata?.checkpointId,
    usage: loopState.usage,
  }
```

- [ ] **Step 6: Run test to verify engine extracts usage (still fails — runtime not writing to snapshot yet)**

Run: `cd packages/runtime && pnpm vitest run src/__tests__/runtime-token-usage.test.ts`
Expected: FAIL — `DeepagentsRunResult.usage` is populated, but runtime doesn't write it to snapshot yet.

- [ ] **Step 7: Commit engine changes**

```bash
git add packages/runtime/src/engines/deepagents-engine.ts
git commit -m "feat(runtime): extract usage_metadata from deepagents on_chat_model_end events"
```

---

### Task 3: Write usage into RunSnapshot and SessionSnapshot in runtime.ts

**Files:**
- Modify: `packages/runtime/src/runtime.ts:529-670` (executeRun method)

- [ ] **Step 1: Import TokenUsage and addTokenUsage in runtime.ts**

Add to the imports from `@tianji/shared`:

```typescript
import {
  type AppMessage,
  CancelledError,
  DEFAULT_EXECUTION_POLICY,
  type ExecutionPolicy,
  type MessageCompletedEvent,
  ProviderError,
  type RunId,
  type RunSnapshot,
  type RuntimeEvent,
  type SessionId,
  type SessionSnapshot,
  TianjiError,
  type TokenUsage,
  type ToolCompletedEvent,
  type ToolFailedEvent,
  type ToolStartedEvent,
  addTokenUsage,
  createRunId,
  createSessionId,
} from '@tianji/shared'
```

- [ ] **Step 2: Write run usage into completed RunSnapshot metadata**

In the `executeRun` method, after `const result = await this.executeDeepagentsTurn(...)` and the completedRunMetadata computation (around line 553), add usage to the metadata:

```typescript
      const completedRunMetadata = writeRunRuntimeMetadata(runSnapshot.metadata, {
        engine: this.engine,
        threadId: result.threadId,
        checkpointId: result.checkpointId,
      })

      // 将 run 级别的 token 用量写入 metadata，供查询和日志使用。
      const runMetadataWithUsage =
        result.usage !== undefined
          ? { ...completedRunMetadata, usage: result.usage }
          : completedRunMetadata
```

Then use `runMetadataWithUsage` instead of `completedRunMetadata` in the `completedRunSnapshot` and `interruptedRunSnapshot` objects.

For the interrupt path (around line 561):
```typescript
        const interruptedRunSnapshot: RunSnapshot = {
          ...runSnapshot,
          status: 'cancelled',
          updatedAt: Date.now(),
          cancelPoint: 'human-in-the-loop',
          pendingOperations: [...context.pendingOperations.values()],
          resumeHint: 'require-user-confirmation',
          workflowState: writeDeepagentsRunWorkflowState({
            threadId: result.threadId,
            checkpointId: result.checkpointId,
            interrupts: result.interrupts,
          }),
          metadata: runMetadataWithUsage,
        }
```

For the normal completion path (around line 600):
```typescript
      const completedRunSnapshot: RunSnapshot = {
        ...runSnapshot,
        status: 'completed',
        messages: nextSessionSnapshot.messages,
        updatedAt: Date.now(),
        pendingOperations: [...context.pendingOperations.values()],
        metadata: runMetadataWithUsage,
      }
```

- [ ] **Step 3: Accumulate session usage**

Before saving `nextSessionSnapshot` (around line 595), accumulate usage:

```typescript
      // 将本次 run 的 token 用量累加到 session 级别。
      const sessionMetadataWithUsage =
        result.usage !== undefined
          ? {
              ...input.sessionSnapshot.metadata,
              usage: addTokenUsage(
                readTokenUsage(input.sessionSnapshot.metadata),
                result.usage
              ),
            }
          : input.sessionSnapshot.metadata

      const nextSessionSnapshot: SessionSnapshot = {
        ...input.sessionSnapshot,
        messages: [...input.sessionSnapshot.messages, ...result.turnMessages],
        updatedAt: Date.now(),
        metadata: sessionMetadataWithUsage,
      }
```

Add a helper function at the bottom of `runtime.ts`:

```typescript
function readTokenUsage(metadata: Record<string, unknown> | undefined): TokenUsage | undefined {
  const usage = metadata?.usage

  if (typeof usage !== 'object' || usage === null) {
    return undefined
  }

  const candidate = usage as { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown }

  if (
    typeof candidate.inputTokens !== 'number' ||
    typeof candidate.outputTokens !== 'number' ||
    typeof candidate.totalTokens !== 'number'
  ) {
    return undefined
  }

  return {
    inputTokens: candidate.inputTokens,
    outputTokens: candidate.outputTokens,
    totalTokens: candidate.totalTokens,
  }
}
```

- [ ] **Step 4: Run tests to verify snapshots contain usage**

Run: `cd packages/runtime && pnpm vitest run src/__tests__/runtime-token-usage.test.ts`
Expected: PASS

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `cd packages/runtime && pnpm vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/runtime.ts
git commit -m "feat(runtime): persist token usage in RunSnapshot and SessionSnapshot metadata"
```

---

### Task 4: Log usage on run completion

**Files:**
- Modify: `packages/runtime/src/runtime.ts:765-789` (logRunLifecycle method)
- Test: `packages/runtime/src/__tests__/runtime-token-usage.test.ts` (extend)

- [ ] **Step 1: Write the failing test for logger output**

Add to `packages/runtime/src/__tests__/runtime-token-usage.test.ts`:

```typescript
import { type ObserverLogEntry, createMemorySink, createObserverLogger } from '@tianji/observer'

// ... inside the describe('Token usage tracking') block:

  it('logs usage in run.completed observer log entry', async () => {
    const memorySink = createMemorySink()
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(
          new AIMessage({
            content: 'Logged',
            usage_metadata: { input_tokens: 300, output_tokens: 120, total_tokens: 420 },
          })
        ),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
      logger: createObserverLogger({ sinks: [memorySink] }),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-usage-log'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-log', 'hi'),
    })
    await collectRuntimeEvents(runId, runtime)
    await waitForRunStatus(runtime, runId, 'completed')

    const completedLogEntry = memorySink.entries.find(
      (entry: ObserverLogEntry) =>
        entry.scope.join('.') === 'runtime.run' && entry.message === 'run.completed'
    ) as (ObserverLogEntry & { data: Record<string, unknown> }) | undefined

    expect(completedLogEntry).toBeDefined()
    expect(completedLogEntry?.data.usage).toEqual({
      inputTokens: 300,
      outputTokens: 120,
      totalTokens: 420,
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/runtime && pnpm vitest run src/__tests__/runtime-token-usage.test.ts`
Expected: FAIL — `completedLogEntry?.data.usage` is `undefined`

- [ ] **Step 3: Pass usage to logRunLifecycle**

In the `executeRun` method, update the `logRunLifecycle` call for `run.completed` (around line 617):

```typescript
      this.logRunLifecycle('info', 'run.completed', lineage, {
        ...(result.usage !== undefined ? { usage: result.usage } : undefined),
      })
```

Also update the interrupted/cancelled `logRunLifecycle` call (around line 583) to include usage:

```typescript
        this.logRunLifecycle('info', 'run.cancelled', lineage, {
          cancelPoint: 'human-in-the-loop',
          ...(result.usage !== undefined ? { usage: result.usage } : undefined),
        })
```

- [ ] **Step 4: Run tests to verify logger output**

Run: `cd packages/runtime && pnpm vitest run src/__tests__/runtime-token-usage.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd packages/runtime && pnpm vitest run`
Expected: All tests PASS

- [ ] **Step 6: Run pnpm check**

Run: `pnpm check`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/runtime.ts packages/runtime/src/__tests__/runtime-token-usage.test.ts
git commit -m "feat(runtime): log token usage in run lifecycle observer entries"
```

---

### Task 5: Export TokenUsage from shared package index

**Files:**
- Modify: `packages/shared/src/index.ts:89`

- [ ] **Step 1: Update the explicit re-export line**

In `packages/shared/src/index.ts`, the line `export type { RunSnapshot, RunStatus, RunTriggerType } from './snapshot.js'` should include `TokenUsage` and `addTokenUsage`. However, since `snapshot.ts` is already `export *`-ed at line 83, `TokenUsage` and `addTokenUsage` are already exported. Verify by checking:

```typescript
// Line 83 already does this:
export * from './snapshot.js'
```

If `TokenUsage` is already covered by the wildcard, no change needed. If the explicit re-export at line 89 shadows the wildcard, add `TokenUsage` and `addTokenUsage` there:

```typescript
export type { RunSnapshot, RunStatus, RunTriggerType, TokenUsage } from './snapshot.js'
export { addTokenUsage } from './snapshot.js'
```

- [ ] **Step 2: Verify export works**

Run: `cd packages/shared && pnpm vitest run src/__tests__/index.test.ts`
Expected: PASS

- [ ] **Step 3: Run pnpm check from repo root**

Run: `pnpm check`
Expected: No errors, no warnings

- [ ] **Step 4: Commit if changes were needed**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): ensure TokenUsage is exported from package index"
```
