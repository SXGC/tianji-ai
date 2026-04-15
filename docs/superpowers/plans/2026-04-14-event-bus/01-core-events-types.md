# 阶段 01：Core 领域事件与 Envelope 类型

> Spec：[../../specs/2026-04-14-event-bus-design.md](../../specs/2026-04-14-event-bus-design.md) §三、§四.1
> 前置：无
> 交付物：`packages/shared/src/events/` 新模块：领域事件联合类型、`DomainEventEnvelope`、辅助 guard 函数与全量类型单测。

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 在 `@tianji/shared` 中落位全部 25 个领域事件 TS 类型与统一 envelope 接口，替代旧 `events.ts` 的 `RuntimeEvent` 输出角色；保留旧 `events.ts` 文件以维持 01 阶段前的编译通过（删除在阶段 08）。

**Architecture:** 新增目录 `packages/shared/src/events/` 内分文件按聚合组织：`session.ts` / `graph-run.ts` / `run.ts` / `task.ts` / `node.ts` / `envelope.ts` / `domain-event.ts` / `index.ts`。每文件只放对应聚合的事件接口。`domain-event.ts` 汇总 `DomainEvent` 联合并导出 `DomainEventType` 字面量联合。`envelope.ts` 放 `AggregateType` / `ProcessKind` / `EnvelopeSource` / `DomainEventEnvelope<T>`。

**Tech Stack:** TypeScript `readonly` 字段、discriminated union（`type` 字段）。

---

## File Structure

- Create: `packages/shared/src/events/envelope.ts`
- Create: `packages/shared/src/events/session.ts`
- Create: `packages/shared/src/events/graph-run.ts`
- Create: `packages/shared/src/events/run.ts`
- Create: `packages/shared/src/events/task.ts`
- Create: `packages/shared/src/events/node.ts`
- Create: `packages/shared/src/events/domain-event.ts`
- Create: `packages/shared/src/events/guards.ts`
- Create: `packages/shared/src/events/index.ts`
- Create: `packages/shared/src/events/__tests__/guards.test.ts`
- Modify: `packages/shared/src/index.ts`（新增 events 子模块 re-export）
- Modify: `packages/shared/package.json`（若 `ulid` 未加，在阶段 03 再加，本阶段不改）

---

### Task 1: 定义 Envelope 及共享基础类型

**Files:**
- Create: `packages/shared/src/events/envelope.ts`

- [ ] **Step 1: 写 envelope.ts**

```ts
/**
 * 统一跨聚合、跨进程的领域事件信封定义。
 * @module events/envelope
 */

import type { DomainEvent } from './domain-event.js'

export type AggregateType = 'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node'

export type ProcessKind = 'daemon' | 'node' | 'cp'

export interface EnvelopeSource {
  readonly processKind: ProcessKind
  readonly processId: string
  readonly nodeId?: string
}

export interface DomainEventEnvelope<T extends DomainEvent = DomainEvent> {
  readonly eventId: string
  readonly type: T['type']
  readonly occurredAt: string
  readonly correlationId: string
  readonly causationId: string | null
  readonly sequence: number
  readonly aggregateType: AggregateType
  readonly aggregateId: string
  readonly source: EnvelopeSource
  readonly payload: T
}
```

- [ ] **Step 2: 提交**

```bash
git add packages/shared/src/events/envelope.ts
git commit -m "feat(shared): 新增 DomainEventEnvelope 与聚合/进程枚举类型"
```

---

### Task 2: Session 聚合事件

**Files:**
- Create: `packages/shared/src/events/session.ts`

- [ ] **Step 1: 写 session.ts**

```ts
/**
 * Session 聚合领域事件。
 * @module events/session
 */

import type { SessionId } from '../identifiers.js'

interface SessionFields {
  readonly sessionId: SessionId
  readonly timestamp: number
}

export interface SessionCreatedEvent extends SessionFields {
  readonly type: 'SessionCreated'
}

export interface SessionResumedEvent extends SessionFields {
  readonly type: 'SessionResumed'
  readonly checkpointId: string
}

export interface SessionClosedEvent extends SessionFields {
  readonly type: 'SessionClosed'
}

export type SessionDomainEvent =
  | SessionCreatedEvent
  | SessionResumedEvent
  | SessionClosedEvent
```

- [ ] **Step 2: 提交**

```bash
git add packages/shared/src/events/session.ts
git commit -m "feat(shared): 新增 Session 聚合领域事件"
```

---

### Task 3: GraphRun 聚合事件

**Files:**
- Create: `packages/shared/src/events/graph-run.ts`

- [ ] **Step 1: 写 graph-run.ts**

```ts
/**
 * GraphRun 聚合领域事件。
 * @module events/graph-run
 */

import type { TianjiError } from '../errors.js'
import type { RunId } from '../identifiers.js'

export type GraphNodeKind = 'agent' | 'acp-agent' | 'human-gate' | 'fork'

interface GraphRunFields {
  readonly runId: RunId
  readonly graphId: string
  readonly graphVersion: number
  readonly timestamp: number
}

export interface GraphRunStartedEvent extends GraphRunFields {
  readonly type: 'GraphRunStarted'
}

export interface GraphRunCompletedEvent extends GraphRunFields {
  readonly type: 'GraphRunCompleted'
  readonly finalState: Record<string, unknown>
}

export interface GraphRunFailedEvent extends GraphRunFields {
  readonly type: 'GraphRunFailed'
  readonly error: TianjiError
}

interface GraphNodeFields {
  readonly runId: RunId
  readonly graphId: string
  readonly nodeId: string
  readonly nodeKind: GraphNodeKind
  readonly timestamp: number
}

export interface GraphNodeStartedEvent extends GraphNodeFields {
  readonly type: 'GraphNodeStarted'
}

export interface GraphNodeCompletedEvent extends GraphNodeFields {
  readonly type: 'GraphNodeCompleted'
  readonly output: Record<string, unknown>
}

export interface GraphNodeFailedEvent extends GraphNodeFields {
  readonly type: 'GraphNodeFailed'
  readonly error: TianjiError
}

export type GraphRunDomainEvent =
  | GraphRunStartedEvent
  | GraphRunCompletedEvent
  | GraphRunFailedEvent
  | GraphNodeStartedEvent
  | GraphNodeCompletedEvent
  | GraphNodeFailedEvent
```

- [ ] **Step 2: 提交**

```bash
git add packages/shared/src/events/graph-run.ts
git commit -m "feat(shared): 新增 GraphRun 聚合领域事件"
```

---

### Task 4: Run 聚合事件（含 Message / Tool entity 事件）

**Files:**
- Create: `packages/shared/src/events/run.ts`

- [ ] **Step 1: 写 run.ts**

```ts
/**
 * Run 聚合领域事件，含 Message / Tool entity 事件。
 * @module events/run
 */

import type { TianjiError, ToolError } from '../errors.js'
import type { RunId, SessionId } from '../identifiers.js'
import type { AppMessage } from '../message.js'
import type { RunTriggerType } from '../snapshot.js'
import type { ToolInvocation, ToolResult } from '../tool.js'

interface RunLifecycleFields {
  readonly runId: RunId
  readonly sessionId: SessionId
  readonly triggerType: RunTriggerType
  readonly parentRunId?: RunId
  readonly timestamp: number
}

export interface RunStartedEvent extends RunLifecycleFields {
  readonly type: 'RunStarted'
}

export interface RunCompletedEvent extends RunLifecycleFields {
  readonly type: 'RunCompleted'
}

export interface RunFailedEvent extends RunLifecycleFields {
  readonly type: 'RunFailed'
  readonly error: TianjiError
}

export type RunCancelledReason = 'hitl' | 'abort'

export interface RunCancelledEvent extends RunLifecycleFields {
  readonly type: 'RunCancelled'
  readonly reason: RunCancelledReason
}

export type MessageDeltaChannel = 'text' | 'thinking'

export interface MessageDeltaPayload {
  readonly content: string
}

export interface MessageStartedEvent {
  readonly type: 'MessageStarted'
  readonly runId: RunId
  readonly messageId: string
  readonly message: AppMessage
  readonly timestamp: number
}

export interface MessageDeltaEvent {
  readonly type: 'MessageDelta'
  readonly runId: RunId
  readonly messageId: string
  readonly sequence: number
  readonly channel: MessageDeltaChannel
  readonly payload: MessageDeltaPayload
  readonly timestamp: number
}

export interface MessageCompletedEvent {
  readonly type: 'MessageCompleted'
  readonly runId: RunId
  readonly messageId: string
  readonly message: AppMessage
  readonly timestamp: number
}

export interface ToolStartedEvent {
  readonly type: 'ToolStarted'
  readonly runId: RunId
  readonly toolCallId: string
  readonly invocation: ToolInvocation
  readonly timestamp: number
}

export interface ToolCompletedEvent {
  readonly type: 'ToolCompleted'
  readonly runId: RunId
  readonly toolCallId: string
  readonly invocation: ToolInvocation
  readonly result: ToolResult
  readonly timestamp: number
}

export interface ToolFailedEvent {
  readonly type: 'ToolFailed'
  readonly runId: RunId
  readonly toolCallId: string
  readonly invocation: ToolInvocation
  readonly error: ToolError
  readonly timestamp: number
}

export type RunDomainEvent =
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
```

- [ ] **Step 2: 注意**：`MessageDeltaEvent.sequence` 是 **Message 内部的片段序号**，与 envelope `sequence`（Run 聚合内事件序号）**不同名同概念但语义不同**。阶段 03 的计数器只管 envelope.sequence；此字段透传 payload。

- [ ] **Step 3: 提交**

```bash
git add packages/shared/src/events/run.ts
git commit -m "feat(shared): 新增 Run 聚合及 Message/Tool entity 领域事件"
```

---

### Task 5: Task 聚合事件（含 TaskObservationLost 例外）

**Files:**
- Create: `packages/shared/src/events/task.ts`

- [ ] **Step 1: 写 task.ts**

```ts
/**
 * Task 聚合领域事件。
 * TaskObservationLost 由 cp 作为观察者发射（spec §四.2 例外）。
 * @module events/task
 */

import type { TianjiError } from '../errors.js'

interface TaskFields {
  readonly taskId: string
  readonly timestamp: number
}

export interface TaskStartedEvent extends TaskFields {
  readonly type: 'TaskStarted'
}

export interface TaskWaitingEvent extends TaskFields {
  readonly type: 'TaskWaiting'
  readonly reason: string
}

export interface TaskSessionAttachedEvent extends TaskFields {
  readonly type: 'TaskSessionAttached'
  readonly sessionId: string
}

export interface TaskCompletedEvent extends TaskFields {
  readonly type: 'TaskCompleted'
}

export interface TaskFailedEvent extends TaskFields {
  readonly type: 'TaskFailed'
  readonly error: TianjiError
}

export interface TaskCancelledEvent extends TaskFields {
  readonly type: 'TaskCancelled'
}

export interface TaskObservationLostEvent extends TaskFields {
  readonly type: 'TaskObservationLost'
  readonly lastObservedAt: string
}

export type TaskDomainEvent =
  | TaskStartedEvent
  | TaskWaitingEvent
  | TaskSessionAttachedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent
  | TaskObservationLostEvent
```

- [ ] **Step 2: 提交**

```bash
git add packages/shared/src/events/task.ts
git commit -m "feat(shared): 新增 Task 聚合领域事件含 TaskObservationLost"
```

---

### Task 6: Node 聚合事件

**Files:**
- Create: `packages/shared/src/events/node.ts`

- [ ] **Step 1: 写 node.ts**

```ts
/**
 * Node 聚合领域事件。writer 为 cp registry。
 * @module events/node
 */

interface NodeFields {
  readonly nodeId: string
  readonly timestamp: number
}

export interface NodeRegisteredEvent extends NodeFields {
  readonly type: 'NodeRegistered'
  readonly version: string
}

export interface NodeReRegisteredEvent extends NodeFields {
  readonly type: 'NodeReRegistered'
  readonly version: string
}

export interface NodeMarkedOfflineEvent extends NodeFields {
  readonly type: 'NodeMarkedOffline'
  readonly reason: string
}

export type NodeDomainEvent =
  | NodeRegisteredEvent
  | NodeReRegisteredEvent
  | NodeMarkedOfflineEvent
```

- [ ] **Step 2: 提交**

```bash
git add packages/shared/src/events/node.ts
git commit -m "feat(shared): 新增 Node 聚合领域事件"
```

---

### Task 7: DomainEvent 联合与字面量类型

**Files:**
- Create: `packages/shared/src/events/domain-event.ts`

- [ ] **Step 1: 写 domain-event.ts**

```ts
/**
 * 聚合全部聚合领域事件的联合类型。
 * @module events/domain-event
 */

import type { GraphRunDomainEvent } from './graph-run.js'
import type { NodeDomainEvent } from './node.js'
import type { RunDomainEvent } from './run.js'
import type { SessionDomainEvent } from './session.js'
import type { TaskDomainEvent } from './task.js'

export type DomainEvent =
  | SessionDomainEvent
  | GraphRunDomainEvent
  | RunDomainEvent
  | TaskDomainEvent
  | NodeDomainEvent

export type DomainEventType = DomainEvent['type']
```

- [ ] **Step 2: 提交**

```bash
git add packages/shared/src/events/domain-event.ts
git commit -m "feat(shared): 聚合 DomainEvent 联合与事件类型字面量"
```

---

### Task 8: 类型 guards（按聚合分类）

**Files:**
- Create: `packages/shared/src/events/guards.ts`
- Create: `packages/shared/src/events/__tests__/guards.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// packages/shared/src/events/__tests__/guards.test.ts
import { describe, expect, it } from 'vitest'
import type { DomainEventEnvelope } from '../envelope.js'
import {
  isNodeEvent,
  isRunEvent,
  isSessionEvent,
  isTaskEvent,
  isGraphRunEvent,
} from '../guards.js'

function envelope(type: string, aggregateType: string): DomainEventEnvelope {
  return {
    eventId: 'evt_1',
    type,
    occurredAt: '2026-04-14T00:00:00Z',
    correlationId: 'corr_1',
    causationId: null,
    sequence: 1,
    aggregateType: aggregateType as never,
    aggregateId: 'agg_1',
    source: { processKind: 'daemon', processId: 'p1' },
    payload: {} as never,
  } as DomainEventEnvelope
}

describe('event guards', () => {
  it('按 aggregateType 区分事件', () => {
    expect(isSessionEvent(envelope('SessionCreated', 'Session'))).toBe(true)
    expect(isGraphRunEvent(envelope('GraphRunStarted', 'GraphRun'))).toBe(true)
    expect(isRunEvent(envelope('RunStarted', 'Run'))).toBe(true)
    expect(isTaskEvent(envelope('TaskStarted', 'Task'))).toBe(true)
    expect(isNodeEvent(envelope('NodeRegistered', 'Node'))).toBe(true)
  })

  it('aggregateType 不匹配返回 false', () => {
    expect(isSessionEvent(envelope('RunStarted', 'Run'))).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @tianji/shared test -- guards.test.ts
```
Expected: FAIL，模块 `../guards.js` 不存在。

- [ ] **Step 3: 写 guards.ts**

```ts
/**
 * 按 aggregateType 区分 envelope 的类型守卫。
 * @module events/guards
 */

import type { DomainEventEnvelope } from './envelope.js'
import type { GraphRunDomainEvent } from './graph-run.js'
import type { NodeDomainEvent } from './node.js'
import type { RunDomainEvent } from './run.js'
import type { SessionDomainEvent } from './session.js'
import type { TaskDomainEvent } from './task.js'

export function isSessionEvent(
  env: DomainEventEnvelope,
): env is DomainEventEnvelope<SessionDomainEvent> {
  return env.aggregateType === 'Session'
}

export function isGraphRunEvent(
  env: DomainEventEnvelope,
): env is DomainEventEnvelope<GraphRunDomainEvent> {
  return env.aggregateType === 'GraphRun'
}

export function isRunEvent(
  env: DomainEventEnvelope,
): env is DomainEventEnvelope<RunDomainEvent> {
  return env.aggregateType === 'Run'
}

export function isTaskEvent(
  env: DomainEventEnvelope,
): env is DomainEventEnvelope<TaskDomainEvent> {
  return env.aggregateType === 'Task'
}

export function isNodeEvent(
  env: DomainEventEnvelope,
): env is DomainEventEnvelope<NodeDomainEvent> {
  return env.aggregateType === 'Node'
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @tianji/shared test -- guards.test.ts
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/events/guards.ts packages/shared/src/events/__tests__/guards.test.ts
git commit -m "feat(shared): 新增按聚合分类的 envelope 类型守卫"
```

---

### Task 9: events 子模块 index 与 shared 根导出

**Files:**
- Create: `packages/shared/src/events/index.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 写 events/index.ts**

```ts
/**
 * Core 领域事件公共出口。
 * @module events
 */

export * from './domain-event.js'
export * from './envelope.js'
export * from './graph-run.js'
export * from './guards.js'
export * from './node.js'
export * from './run.js'
export * from './session.js'
export * from './task.js'
```

- [ ] **Step 2: 读取 shared 根 index.ts 再决定如何 re-export**

```bash
# 使用 Read 工具打开 packages/shared/src/index.ts
```

- [ ] **Step 3: 在 packages/shared/src/index.ts 中新增一行：**

```ts
export * from './events/index.js'
```

放在现有其他 `export *` 之后。旧 `events.ts` 的 `export * from './events.js'` **保留**（阶段 08 再删）。

- [ ] **Step 4: 解决命名冲突**：旧 `events.ts` 已导出 `MessageDeltaChannel` / `MessageDeltaPayload` / `GraphNodeKind` 等同名符号。需要在 `packages/shared/src/index.ts` 中把旧 `events.ts` 的 re-export 改为显式指定名单（旧的保留 `RuntimeEvent*` 等旧类型名），而把新名让给 `events/` 子模块。示例（改现有行）：

```ts
// 从：
export * from './events.js'
// 改为：
export {
  type RuntimeEvent,
  type RuntimeEventType,
  type RunStartedEvent as LegacyRunStartedEvent,
  type RunCompletedEvent as LegacyRunCompletedEvent,
  type RunFailedEvent as LegacyRunFailedEvent,
  type RunCancelledEvent as LegacyRunCancelledEvent,
  type MessageStartedEvent as LegacyMessageStartedEvent,
  type MessageDeltaEvent as LegacyMessageDeltaEvent,
  type MessageCompletedEvent as LegacyMessageCompletedEvent,
  type ToolStartedEvent as LegacyToolStartedEvent,
  type ToolCompletedEvent as LegacyToolCompletedEvent,
  type ToolFailedEvent as LegacyToolFailedEvent,
  type GraphStartedEvent,
  type GraphNodeStartedEvent as LegacyGraphNodeStartedEvent,
  type GraphNodeCompletedEvent as LegacyGraphNodeCompletedEvent,
  type GraphNodeFailedEvent as LegacyGraphNodeFailedEvent,
  type GraphCompletedEvent,
  type GraphEvent,
  type GraphEventType,
} from './events.js'
```

并补一行（若旧联合 `MessageDeltaChannel` 等也被旧 `events.ts` 导出且外部使用）仅在必要时 alias。**原则**：新名独占 `@tianji/shared` 的导出表；旧名加 `Legacy` 前缀维持 01 阶段编译通过。

- [ ] **Step 5: 跑包内类型检查**

```bash
pnpm --filter @tianji/shared build
```
Expected: PASS。若失败，读取报错文件的 Legacy 引用点，将其本地别名改回 `LegacyRunStartedEvent` 等。

- [ ] **Step 6: 跑整仓 check**

```bash
pnpm check
```
Expected：修复所有 error / warning / info。若 `@tianji/runtime` / `@tianji/agent` 因旧名丢失报错，逐个 import 改为 Legacy 别名。**不得**改动 runtime / agent 业务逻辑，只改 import 别名。

- [ ] **Step 7: 提交**

```bash
git add packages/shared/src/events/index.ts packages/shared/src/index.ts
git add packages/runtime packages/agent apps
git commit -m "feat(shared): 导出 events 子模块并将旧事件类型改为 Legacy 别名"
```

---

## Self-Review Checklist

- [ ] Spec §三.3 表格中 25 个事件全部在本阶段定义（Session 3 + GraphRun 6 + Run 10 + Task 7 + Node 3 = 29；含 `MessageStarted/Delta/Completed/Tool*` 合计在 Run 下）。
- [ ] PascalCase 一致，TS 类型名 = envelope.type 字符串。
- [ ] `DomainEventEnvelope.payload` 的 `T extends DomainEvent` 泛型闭合。
- [ ] 旧 `events.ts` / `task-event.ts` 均未删（阶段 08 删）。
- [ ] 未加 `any`、未加 `import()`、未超 800 行。
- [ ] `pnpm check` 全绿。
