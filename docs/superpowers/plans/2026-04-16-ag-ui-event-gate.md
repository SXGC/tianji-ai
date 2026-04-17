# AG-UI 事件收尾闸门（AgUiEventGate）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `TianjiAgent` 的 AG-UI 事件出口加一道 `AgUiEventGate` 闸门，保证 `RUN_FINISHED` / `RUN_ERROR` 发出前所有已开的 `TEXT_MESSAGE_START` / `REASONING_*` 都被对称关闭，消除前端 `"Cannot send 'RUN_FINISHED' while text messages are still active"` 告警。

**Architecture:** 新增 `AgUiEventGate` class 作为 subscriber 的代理出口层。gate 观察 AG-UI 事件类型自行维护 `active: Map<messageId, {inThinking, hasText}>`；`emitTerminal` 前按 Map 插入顺序 flush 所有活跃消息（`inThinking` 条目发 `REASONING_MESSAGE_END` + `REASONING_END`；`hasText` 条目发 `TEXT_MESSAGE_END`）并打 error 日志；`emit` 在终态后变空操作；`dispose` 作为保险网。`tianji-agent.ts` 把所有 `subscriber.next` 替换为 `gate.emit` / `gate.emitTerminal`，`event-mapper.ts` 完全不动，保持纯函数性质。

**Tech Stack:** TypeScript + vitest + `@ag-ui/client` 的 `BaseEvent` / `EventType` + `@tianji/observer` 的 `ObserverLogger` + `createMemorySink` + rxjs `Observable` / `toArray` / `lastValueFrom`。

参考 spec：`docs/superpowers/specs/2026-04-16-ag-ui-event-gate-design.md`

---

## File Structure

**将创建：**
- `apps/controlplane/src/agents/ag-ui-event-gate.ts` — `AgUiEventGate` class + `Subscriber` / `AgUiEventGateContext` 类型 + `isTerminalAgUiEvent` 辅助。单文件单职责，预计约 150 行。
- `apps/controlplane/src/agents/__tests__/ag-ui-event-gate.test.ts` — 闸门单测（T1–T8）。
- `apps/controlplane/src/agents/__tests__/tianji-agent.gate.integration.test.ts` — 闸门 + tianji-agent 集成测试（I1–I4）。

**将修改：**
- `apps/controlplane/src/agents/tianji-agent.ts` — 构造新增 `logger: ObserverLogger`（**必传，无默认**），订阅回调由直接 `subscriber.next` 改为走 gate，删除 `sawTerminalAgUiEvent` 本地变量，`subscriber.complete()` 前调用 `gate.dispose()`。
- `apps/controlplane/src/routes/copilot.ts` — `createCopilotRoute` 签名新增 `logger: ObserverLogger` 参数（必传），两处 `new TianjiAgent` 把 logger 传入。
- `apps/controlplane/src/app.ts` — 调用 `createCopilotRoute(db, bus)` 处改为 `createCopilotRoute(db, logger, bus)`。
- `apps/controlplane/src/agents/__tests__/tianji-agent.test.ts` — 每处 `new TianjiAgent(...)` 补 logger 参数（用 memory sink）。
- `apps/controlplane/src/routes/__tests__/copilot.test.ts` — 调用 `createCopilotRoute` 的两处补 logger 参数。

**不动：**
- `apps/controlplane/src/agents/event-mapper.ts` — 保持纯函数。
- 所有 ACP 相关代码。

---

## 前置约定（所有任务遵守）

- 所有 `.ts` 文件必须顶部导入（CLAUDE.md 硬性要求）。
- class 内部字段统一 `#` private，与 `tianji-agent.ts` 现风格一致。
- 日志走 `@tianji/observer` 的 `ObserverLogger`：`logger.error(scope, message, data)`；本闸门 scope 用模块级常量：
  ```ts
  const SCOPE_AG_UI_GATE = ['controlplane', 'agents', 'ag-ui-gate'] as const
  ```
  风格与 `SCOPE_SERVER` / `SCOPE_AUTH` / `SCOPE_MONITOR` 一致。
- 测试里的 logger 统一用 `createObserverLogger({ sinks: [createMemorySink()] })`，断言用 `sink.entries`，不手写 8 个 `vi.fn()`。
- 所有测试和实现代码里 AG-UI 事件构造都用 `EventType.XXX` enum，不用字符串字面量。测试断言接收到的事件 `type` 字段可写字符串字面量（rxjs 收到的 event.type 就是 enum 求值后的字符串）。
- 测试命令：`pnpm --filter @tianji/controlplane test -- <关键字>`。
- 每个 Task 完成后 commit，提交前先触发 `git-commit` skill（CLAUDE.md 硬性要求）。
- 全部 Task 完成后在仓库根跑 `pnpm check`，修复全部 error / warn / info。

---

## Task 1：AgUiEventGate 骨架 + 类型 + 构造器

**目标：** 打地基。TDD 从"构造 + alreadyTerminated 初值"起步，确认 class 能被 new、字段被正确持有。

**Files:**
- Create: `apps/controlplane/src/agents/ag-ui-event-gate.ts`
- Create: `apps/controlplane/src/agents/__tests__/ag-ui-event-gate.test.ts`

- [ ] **Step 1.1：写最小失败测试**

`apps/controlplane/src/agents/__tests__/ag-ui-event-gate.test.ts`：

```ts
import type { BaseEvent } from '@ag-ui/client'
import { createMemorySink, createObserverLogger } from '@tianji/observer'
import type { ObserverMemorySink } from '@tianji/observer'
import { describe, expect, it, vi } from 'vitest'

import { AgUiEventGate } from '../ag-ui-event-gate.js'

function makeGate() {
  const subscriber = { next: vi.fn<(e: BaseEvent) => void>() }
  const sink: ObserverMemorySink = createMemorySink()
  const logger = createObserverLogger({ sinks: [sink] })
  const gate = new AgUiEventGate(subscriber, { runId: 'run-1', threadId: 'thread-1' }, logger)
  return { subscriber, sink, logger, gate }
}

describe('AgUiEventGate', () => {
  it('新建时 alreadyTerminated 为 false，未向下游发任何事件', () => {
    const { subscriber, gate } = makeGate()

    expect(gate.alreadyTerminated()).toBe(false)
    expect(subscriber.next).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 1.2：跑测试确认失败**

```
pnpm --filter @tianji/controlplane test -- ag-ui-event-gate
```

期望：`Cannot find module '../ag-ui-event-gate.js'`。

- [ ] **Step 1.3：写骨架实现**

`apps/controlplane/src/agents/ag-ui-event-gate.ts`：

```ts
/**
 * AgUiEventGate - AG-UI 事件出口闸门
 *
 * 观察 AG-UI 事件类型自行维护活跃 messageId 集合；终态事件发出前 flush
 * 所有活跃消息；作为协议层保险网，让 event-mapper 保持纯函数。
 *
 * @module ag-ui-event-gate
 */
import { EventType } from '@ag-ui/client'
import type { BaseEvent } from '@ag-ui/client'
import type { ObserverLogger } from '@tianji/observer'

export interface Subscriber {
  next(event: BaseEvent): void
}

export interface AgUiEventGateContext {
  runId: string
  threadId: string
}

const SCOPE_AG_UI_GATE = ['controlplane', 'agents', 'ag-ui-gate'] as const

interface ActiveEntry {
  inThinking: boolean
  hasText: boolean
}

export class AgUiEventGate {
  readonly #subscriber: Subscriber
  readonly #context: AgUiEventGateContext
  readonly #logger: ObserverLogger
  readonly #active = new Map<string, ActiveEntry>()
  #terminated = false
  #disposed = false

  constructor(subscriber: Subscriber, context: AgUiEventGateContext, logger: ObserverLogger) {
    this.#subscriber = subscriber
    this.#context = context
    this.#logger = logger
  }

  alreadyTerminated(): boolean {
    return this.#terminated
  }

  emit(_event: BaseEvent): void {
    throw new Error('Not implemented')
  }

  emitTerminal(_event: BaseEvent): void {
    throw new Error('Not implemented')
  }

  dispose(): void {
    throw new Error('Not implemented')
  }
}

export function isTerminalAgUiEvent(event: BaseEvent): boolean {
  return event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR
}
```

- [ ] **Step 1.4：跑测试确认通过**

```
pnpm --filter @tianji/controlplane test -- ag-ui-event-gate
```

- [ ] **Step 1.5：commit（触发 git-commit skill）**

---

## Task 2：emit 普通透传 + 活跃集合基础追踪

**目标：** 实现 `TEXT_MESSAGE_START` / `TEXT_MESSAGE_END` 追踪、非相关事件原样透传。

**Files:**
- Modify: `apps/controlplane/src/agents/ag-ui-event-gate.ts`
- Modify: `apps/controlplane/src/agents/__tests__/ag-ui-event-gate.test.ts`

- [ ] **Step 2.1：写失败测试**

```ts
import { EventType } from '@ag-ui/client'
// ... makeGate 已在 Step 1.1 定义，直接复用

it('TEXT_MESSAGE_START 进入 active，TEXT_MESSAGE_END 移出 active', () => {
  const { subscriber, gate } = makeGate()

  const startEv = { type: EventType.TEXT_MESSAGE_START, messageId: 'M1', role: 'assistant' } as BaseEvent
  const contentEv = { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'M1', delta: 'hi' } as BaseEvent
  const endEv = { type: EventType.TEXT_MESSAGE_END, messageId: 'M1' } as BaseEvent

  gate.emit(startEv)
  gate.emit(contentEv)
  gate.emit(endEv)

  expect(subscriber.next).toHaveBeenCalledTimes(3)
  expect(subscriber.next).toHaveBeenNthCalledWith(1, startEv)
  expect(subscriber.next).toHaveBeenNthCalledWith(2, contentEv)
  expect(subscriber.next).toHaveBeenNthCalledWith(3, endEv)
})

it('非 TEXT / REASONING 事件原样透传', () => {
  const { subscriber, gate } = makeGate()

  const stateDelta = { type: EventType.STATE_DELTA, delta: [] } as BaseEvent
  gate.emit(stateDelta)

  expect(subscriber.next).toHaveBeenCalledWith(stateDelta)
})
```

- [ ] **Step 2.2：跑测试确认失败**

期望：`Not implemented`。

- [ ] **Step 2.3：实现 emit 与 #trackEvent**

替换 `ag-ui-event-gate.ts` 中的 `emit`：

```ts
emit(event: BaseEvent): void {
  if (this.#terminated) {
    void this.#logger.warn(SCOPE_AG_UI_GATE, 'emit after terminal, ignored', {
      runId: this.#context.runId,
      threadId: this.#context.threadId,
      eventType: event.type,
    })
    return
  }

  this.#trackEvent(event)
  this.#subscriber.next(event)
}

#trackEvent(event: BaseEvent): void {
  const e = event as BaseEvent & { messageId?: string }
  const mid = typeof e.messageId === 'string' ? e.messageId : undefined
  if (mid === undefined) return

  switch (event.type) {
    case EventType.TEXT_MESSAGE_START: {
      const entry = this.#active.get(mid)
      if (entry !== undefined) entry.hasText = true
      else this.#active.set(mid, { inThinking: false, hasText: true })
      return
    }
    case EventType.REASONING_START: {
      const entry = this.#active.get(mid)
      if (entry !== undefined) entry.inThinking = true
      else this.#active.set(mid, { inThinking: true, hasText: false })
      return
    }
    case EventType.REASONING_END: {
      const entry = this.#active.get(mid)
      if (entry !== undefined) entry.inThinking = false
      return
    }
    case EventType.TEXT_MESSAGE_END:
      this.#active.delete(mid)
      return
    default:
      return
  }
}
```

`ActiveEntry` 拆成 `{ inThinking, hasText }` 两个字段的原因：`hasText` 标识"前端是否见过 TEXT_MESSAGE_START"；`REASONING_START` 先到、TEXT 从未到的场景下 `hasText = false`，flush 时**不补** `TEXT_MESSAGE_END`，避免给前端发一个它没开过的消息的 END（违反 AG-UI 协议）。

- [ ] **Step 2.4：跑测试确认通过**

- [ ] **Step 2.5：commit**

---

## Task 3：emitTerminal 非空 flush + error 日志

**目标：** 核心行为。`emitTerminal` 前按 Map 插入顺序 flush，每条按 `inThinking` / `hasText` 决定发送序列，error 日志带 runId / threadId / messageIds。

**Files:**
- Modify: `apps/controlplane/src/agents/ag-ui-event-gate.ts`
- Modify: `apps/controlplane/src/agents/__tests__/ag-ui-event-gate.test.ts`

- [ ] **Step 3.1：写失败测试（T1 正常 + T2 失败 flush + T4 多活跃）**

```ts
it('T1 正常路径：START → CONTENT → END → RUN_FINISHED，无 flush 无 error 日志', () => {
  const { subscriber, sink, gate } = makeGate()

  gate.emit({ type: EventType.TEXT_MESSAGE_START, messageId: 'M1', role: 'assistant' } as BaseEvent)
  gate.emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'M1', delta: 'hi' } as BaseEvent)
  gate.emit({ type: EventType.TEXT_MESSAGE_END, messageId: 'M1' } as BaseEvent)

  const finishEv = { type: EventType.RUN_FINISHED, threadId: 'thread-1', runId: 'run-1' } as BaseEvent
  gate.emitTerminal(finishEv)

  expect(subscriber.next).toHaveBeenCalledTimes(4)
  expect(subscriber.next).toHaveBeenLastCalledWith(finishEv)
  expect(sink.entries.some((e) => e.level === 'error')).toBe(false)
  expect(gate.alreadyTerminated()).toBe(true)
})

it('T2 失败路径：活跃消息在 RUN_ERROR 前被 flush，error 日志列出泄漏 id', () => {
  const { subscriber, sink, gate } = makeGate()

  gate.emit({ type: EventType.TEXT_MESSAGE_START, messageId: 'M1', role: 'assistant' } as BaseEvent)
  gate.emitTerminal({ type: EventType.RUN_ERROR, message: 'boom' } as BaseEvent)

  const types = subscriber.next.mock.calls.map((c) => (c[0] as BaseEvent).type)
  expect(types).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_END', 'RUN_ERROR'])

  const errorEntries = sink.entries.filter((e) => e.level === 'error')
  expect(errorEntries).toHaveLength(1)
  expect(errorEntries[0].scope).toEqual(['controlplane', 'agents', 'ag-ui-gate'])
  expect(errorEntries[0].data).toMatchObject({
    runId: 'run-1',
    threadId: 'thread-1',
    messageIds: ['M1'],
  })
})

it('T4 多活跃消息按 Map 插入顺序 flush', () => {
  const { subscriber, sink, gate } = makeGate()

  gate.emit({ type: EventType.TEXT_MESSAGE_START, messageId: 'M1', role: 'assistant' } as BaseEvent)
  gate.emit({ type: EventType.TEXT_MESSAGE_START, messageId: 'M2', role: 'assistant' } as BaseEvent)

  gate.emitTerminal({ type: EventType.RUN_FINISHED, threadId: 'thread-1', runId: 'run-1' } as BaseEvent)

  const endMessageIds = subscriber.next.mock.calls
    .filter((c) => (c[0] as BaseEvent).type === 'TEXT_MESSAGE_END')
    .map((c) => (c[0] as BaseEvent & { messageId: string }).messageId)
  expect(endMessageIds).toEqual(['M1', 'M2'])

  const errorEntries = sink.entries.filter((e) => e.level === 'error')
  expect(errorEntries[0].data).toMatchObject({ messageIds: ['M1', 'M2'] })
})
```

- [ ] **Step 3.2：跑测试确认失败**

- [ ] **Step 3.3：实现 emitTerminal + #flushActive**

```ts
emitTerminal(event: BaseEvent): void {
  if (this.#terminated) {
    void this.#logger.warn(SCOPE_AG_UI_GATE, 'emitTerminal called more than once, ignored', {
      runId: this.#context.runId,
      threadId: this.#context.threadId,
      eventType: event.type,
    })
    return
  }

  if (this.#active.size > 0) {
    this.#flushActive('terminal')
  }

  this.#subscriber.next(event)
  this.#terminated = true
}

#flushActive(reason: 'terminal' | 'dispose'): void {
  const leakedIds: string[] = []
  const leakedState: Record<string, { inThinking: boolean; hasText: boolean }> = {}

  for (const [messageId, entry] of this.#active) {
    leakedIds.push(messageId)
    leakedState[messageId] = { inThinking: entry.inThinking, hasText: entry.hasText }

    if (entry.inThinking) {
      this.#subscriber.next({ type: EventType.REASONING_MESSAGE_END, messageId } as BaseEvent)
      this.#subscriber.next({ type: EventType.REASONING_END, messageId } as BaseEvent)
    }
    if (entry.hasText) {
      this.#subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent)
    }
  }
  this.#active.clear()

  void this.#logger.error(
    SCOPE_AG_UI_GATE,
    reason === 'terminal'
      ? 'active text messages on terminal, flushed'
      : 'active text messages on dispose without terminal, flushed',
    {
      runId: this.#context.runId,
      threadId: this.#context.threadId,
      messageIds: leakedIds,
      leakedState,
    }
  )
}
```

注意：`#flushActive` 两个分支（`inThinking` / `hasText`）独立判断。`hasText` 为 false 的条目（只有 `REASONING_START` 开过，没有 `TEXT_MESSAGE_START`）只发 REASONING 序列，不补 `TEXT_MESSAGE_END`。

- [ ] **Step 3.4：跑测试确认通过**

- [ ] **Step 3.5：commit**

---

## Task 4：thinking flush 序列（T3 + T8）

**目标：** 覆盖 `REASONING_START` 已开、终态到达时的 flush 行为。Task 3 的 `#flushActive` 已实现两种条目分支，本 Task **纯加测试锁行为**（不再写 Red 步）。

**Files:**
- Modify: `apps/controlplane/src/agents/__tests__/ag-ui-event-gate.test.ts`

- [ ] **Step 4.1：写测试锁行为**

```ts
it('T3 取消路径含 thinking：flush 发 REASONING_MESSAGE_END → REASONING_END → TEXT_MESSAGE_END', () => {
  const { subscriber, sink, gate } = makeGate()

  gate.emit({ type: EventType.TEXT_MESSAGE_START, messageId: 'M1', role: 'assistant' } as BaseEvent)
  gate.emit({ type: EventType.REASONING_START, messageId: 'M1' } as BaseEvent)
  gate.emit({ type: EventType.REASONING_MESSAGE_START, messageId: 'M1' } as BaseEvent)
  gate.emit({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'M1', delta: '...' } as BaseEvent)

  gate.emitTerminal({
    type: EventType.RUN_FINISHED,
    threadId: 'thread-1',
    runId: 'run-1',
    reason: 'cancelled',
  } as BaseEvent)

  const types = subscriber.next.mock.calls.map((c) => (c[0] as BaseEvent).type)
  expect(types).toEqual([
    'TEXT_MESSAGE_START',
    'REASONING_START',
    'REASONING_MESSAGE_START',
    'REASONING_MESSAGE_CONTENT',
    'REASONING_MESSAGE_END',
    'REASONING_END',
    'TEXT_MESSAGE_END',
    'RUN_FINISHED',
  ])
  expect(sink.entries.some((e) => e.level === 'error')).toBe(true)
})

it('REASONING_END 先到则清除 inThinking，后续 TEXT_MESSAGE_END 从 active 删除，无 flush', () => {
  const { subscriber, sink, gate } = makeGate()

  gate.emit({ type: EventType.TEXT_MESSAGE_START, messageId: 'M1', role: 'assistant' } as BaseEvent)
  gate.emit({ type: EventType.REASONING_START, messageId: 'M1' } as BaseEvent)
  gate.emit({ type: EventType.REASONING_END, messageId: 'M1' } as BaseEvent)
  gate.emit({ type: EventType.TEXT_MESSAGE_END, messageId: 'M1' } as BaseEvent)

  gate.emitTerminal({ type: EventType.RUN_FINISHED, threadId: 'thread-1', runId: 'run-1' } as BaseEvent)

  expect(sink.entries.some((e) => e.level === 'error')).toBe(false)
  const types = subscriber.next.mock.calls.map((c) => (c[0] as BaseEvent).type)
  expect(types).toEqual([
    'TEXT_MESSAGE_START',
    'REASONING_START',
    'REASONING_END',
    'TEXT_MESSAGE_END',
    'RUN_FINISHED',
  ])
})

it('T8 REASONING_START 先到、TEXT_MESSAGE_START 从未到：flush 只发 REASONING 序列，不补 TEXT_MESSAGE_END', () => {
  const { subscriber, sink, gate } = makeGate()

  gate.emit({ type: EventType.REASONING_START, messageId: 'M1' } as BaseEvent)
  gate.emitTerminal({ type: EventType.RUN_FINISHED, threadId: 'thread-1', runId: 'run-1' } as BaseEvent)

  const types = subscriber.next.mock.calls.map((c) => (c[0] as BaseEvent).type)
  expect(types).toEqual([
    'REASONING_START',
    'REASONING_MESSAGE_END',
    'REASONING_END',
    'RUN_FINISHED',
  ])
  expect(sink.entries.some((e) => e.level === 'error')).toBe(true)
})
```

注意 T8：前端从未见过 `TEXT_MESSAGE_START`，所以 flush **不能** 补 `TEXT_MESSAGE_END`；只补 `REASONING` 闭合。这是本计划对 spec §5.3 未明说的 flush 行为的补齐。

- [ ] **Step 4.2：跑测试**

```
pnpm --filter @tianji/controlplane test -- ag-ui-event-gate
```

期望：全部 PASS。若 T8 fail，说明 Task 3 的 `#flushActive` 把 `hasText` 判断漏了，回 Task 3 修。

- [ ] **Step 4.3：commit**

---

## Task 5：重复 emitTerminal + 终态后 emit 的防御（T5 + T6）

**目标：** 覆盖 Task 2/3 已实现但没显式断言的幂等路径。**本 Task 不触及 dispose**。

**Files:**
- Modify: `apps/controlplane/src/agents/__tests__/ag-ui-event-gate.test.ts`

- [ ] **Step 5.1：写测试**

```ts
it('T5 重复调用 emitTerminal：第二次被忽略并 warn', () => {
  const { subscriber, sink, gate } = makeGate()

  const first = { type: EventType.RUN_FINISHED, threadId: 'thread-1', runId: 'run-1' } as BaseEvent
  const second = { type: EventType.RUN_ERROR, message: 'late' } as BaseEvent

  gate.emitTerminal(first)
  gate.emitTerminal(second)

  expect(subscriber.next).toHaveBeenCalledTimes(1)
  expect(subscriber.next).toHaveBeenCalledWith(first)
  expect(sink.entries.filter((e) => e.level === 'warn')).toHaveLength(1)
  expect(gate.alreadyTerminated()).toBe(true)
})

it('T6 终态后 emit 为空操作并 warn', () => {
  const { subscriber, sink, gate } = makeGate()

  gate.emitTerminal({ type: EventType.RUN_FINISHED, threadId: 'thread-1', runId: 'run-1' } as BaseEvent)
  subscriber.next.mockClear()

  gate.emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'M1', delta: 'late' } as BaseEvent)

  expect(subscriber.next).not.toHaveBeenCalled()
  const warnEntries = sink.entries.filter((e) => e.level === 'warn')
  expect(warnEntries.length).toBeGreaterThanOrEqual(1)
  expect(warnEntries[warnEntries.length - 1].data).toMatchObject({ eventType: 'TEXT_MESSAGE_CONTENT' })
})
```

- [ ] **Step 5.2：跑测试**

期望：直接 PASS（行为已在 Task 2 / Task 3 实现）。不要求先 Red。

- [ ] **Step 5.3：commit**

---

## Task 6：dispose 作为兜底（T7）

**目标：** 实现 `dispose`。若 `terminated==true`：空操作；若 `terminated==false && active.size>0`：flush + error 日志，**不发终态事件**。重复 dispose 空操作。

**Files:**
- Modify: `apps/controlplane/src/agents/ag-ui-event-gate.ts`
- Modify: `apps/controlplane/src/agents/__tests__/ag-ui-event-gate.test.ts`

- [ ] **Step 6.1：写失败测试**

```ts
it('正常终态后 dispose 为空操作且可重入', () => {
  const { subscriber, sink, gate } = makeGate()

  gate.emitTerminal({ type: EventType.RUN_FINISHED, threadId: 'thread-1', runId: 'run-1' } as BaseEvent)
  subscriber.next.mockClear()
  const beforeErrorCount = sink.entries.filter((e) => e.level === 'error').length

  gate.dispose()
  gate.dispose()

  expect(subscriber.next).not.toHaveBeenCalled()
  expect(sink.entries.filter((e) => e.level === 'error').length).toBe(beforeErrorCount)
})

it('T7 业务方忘记 emitTerminal：dispose flush 活跃消息但不发终态事件', () => {
  const { subscriber, sink, gate } = makeGate()

  gate.emit({ type: EventType.TEXT_MESSAGE_START, messageId: 'M1', role: 'assistant' } as BaseEvent)
  gate.dispose()

  const types = subscriber.next.mock.calls.map((c) => (c[0] as BaseEvent).type)
  expect(types).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_END'])

  const errorEntries = sink.entries.filter((e) => e.level === 'error')
  expect(errorEntries).toHaveLength(1)
  expect(errorEntries[0].message).toContain('without terminal')
  expect(errorEntries[0].data).toMatchObject({ messageIds: ['M1'] })
})
```

- [ ] **Step 6.2：跑测试确认失败**

- [ ] **Step 6.3：实现 dispose**

```ts
dispose(): void {
  if (this.#disposed) return
  this.#disposed = true

  if (!this.#terminated && this.#active.size > 0) {
    this.#flushActive('dispose')
  }
}
```

- [ ] **Step 6.4：跑测试确认通过**

此刻 T1–T8 全部覆盖完毕。

- [ ] **Step 6.5：commit**

---

## Task 7：tianji-agent.ts 接入 gate + 装配层打通 logger 传递

**目标：** 把 `tianji-agent.ts` 的 `subscriber.next` 全部替换为 gate；`logger` 作为必传构造参数；装配层 `app.ts` / `copilot.ts` 把 logger 一路传下来；现有 `tianji-agent.test.ts` / `copilot.test.ts` 按新签名修正。

**Files:**
- Modify: `apps/controlplane/src/agents/tianji-agent.ts`
- Modify: `apps/controlplane/src/routes/copilot.ts`
- Modify: `apps/controlplane/src/app.ts`
- Modify: `apps/controlplane/src/agents/__tests__/tianji-agent.test.ts`
- Modify: `apps/controlplane/src/routes/__tests__/copilot.test.ts`
- Create: `apps/controlplane/src/agents/__tests__/tianji-agent.gate.integration.test.ts`

- [ ] **Step 7.1：审 controlplane 内所有 TianjiAgent 构造点与 createCopilotRoute 调用点**

```
Grep "new TianjiAgent" apps/controlplane/src
Grep "createCopilotRoute" apps/controlplane/src
```

记录每处位置，Step 7.5 / 7.6 按此清单逐个修改。预期清单（截至计划撰写时）：

- `apps/controlplane/src/agents/tianji-agent.ts:218` （`clone()`）
- `apps/controlplane/src/routes/copilot.ts:56` （`/api/copilot`）
- `apps/controlplane/src/routes/copilot.ts:98` （`/api/copilot/cancel`）
- `apps/controlplane/src/agents/__tests__/tianji-agent.test.ts` 共 10 处
- `apps/controlplane/src/routes/__tests__/copilot.test.ts:17, 142`
- `apps/controlplane/src/app.ts:76` （`createCopilotRoute(db, bus)`）

- [ ] **Step 7.2：写集成测试（先失败）**

创建 `apps/controlplane/src/agents/__tests__/tianji-agent.gate.integration.test.ts`：

```ts
import type { BaseEvent } from '@ag-ui/client'
import { createMemorySink, createObserverLogger } from '@tianji/observer'
import type { ObserverMemorySink } from '@tianji/observer'
import type { DomainEvent, DomainEventEnvelope } from '@tianji/shared'
import { createEventBus } from '@tianji/shared'
import { firstValueFrom, lastValueFrom, toArray } from 'rxjs'
import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { TianjiAgent } from '../tianji-agent.js'

describe('TianjiAgent × AgUiEventGate 集成', () => {
  let db: ControlPlaneDb
  afterEach(() => db?.close())

  function setupOnlineNode(nodeId: string) {
    db.raw
      .prepare(
        `INSERT INTO enrollment_tokens (token, created_at) VALUES ('test-token', ${Date.now()})
         ON CONFLICT(token) DO NOTHING`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO nodes
           (node_id, hostname, platform, version, status, access_token_hash, access_token_expires_at, enrollment_token, created_at, updated_at)
         VALUES (?, 'host', 'linux', '1.0.0', 'online', 'hash', ${Date.now() + 3600000}, 'test-token', ${Date.now()}, ${Date.now()})`
      )
      .run(nodeId)
  }

  /** 复用 event-mapper.test.ts 的 envelope 构造风格，字段完整才通过类型检查 */
  function envelope(aggregateId: string, sequence: number, payload: DomainEvent): DomainEventEnvelope {
    return {
      eventId: `e-${sequence}`,
      type: payload.type,
      occurredAt: new Date(1_700_000_000_000 + sequence).toISOString(),
      correlationId: 'test-correlation',
      causationId: null,
      sequence,
      aggregateType: 'Task',
      aggregateId,
      source: { processKind: 'node', processId: 'node-proc-1', nodeId: 'node-1' },
      payload,
    }
  }

  function bootstrapRun() {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')
    const bus = createEventBus({ lagSink: () => undefined })
    const sink: ObserverMemorySink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const agent = new TianjiAgent(db, 'node-1', 'agent-1', bus, logger)

    const stream$ = agent.run({
      messages: [{ id: 'u1', role: 'user', content: 'hi' }],
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
    })
    const eventsPromise = lastValueFrom(stream$.pipe(toArray()))

    // Observable 工厂同步插入 tasks，订阅时立即可查
    const subscription = stream$.subscribe()
    const row = db.raw.prepare('SELECT task_id FROM tasks').get() as { task_id: string }

    return { bus, sink, taskId: row.task_id, eventsPromise, subscription }
  }

  it('I1 成功路径：最后一个事件是 RUN_FINISHED，无 error 日志', async () => {
    const { bus, sink, taskId, eventsPromise } = bootstrapRun()
    let seq = 1
    bus.publish(envelope(taskId, seq++, { type: 'TaskStarted', payload: {} } as DomainEvent))
    bus.publish(envelope(taskId, seq++, { type: 'MessageStarted', payload: { messageId: 'M1' } } as DomainEvent))
    bus.publish(envelope(taskId, seq++, { type: 'MessageDelta', payload: { messageId: 'M1', channel: 'text', payload: { content: 'ok' } } } as DomainEvent))
    bus.publish(envelope(taskId, seq++, { type: 'MessageCompleted', payload: { messageId: 'M1' } } as DomainEvent))
    bus.publish(envelope(taskId, seq++, { type: 'TaskCompleted', payload: {} } as DomainEvent))

    const events = await eventsPromise
    const types = events.map((e) => e.type)
    expect(types[types.length - 1]).toBe('RUN_FINISHED')
    expect(types.lastIndexOf('TEXT_MESSAGE_END')).toBeLessThan(types.indexOf('RUN_FINISHED'))
    expect(sink.entries.some((e) => e.level === 'error')).toBe(false)
  })

  it('I2 失败路径：TEXT_MESSAGE_END 出现在 RUN_ERROR 之前', async () => {
    const { bus, sink, taskId, eventsPromise } = bootstrapRun()
    let seq = 1
    bus.publish(envelope(taskId, seq++, { type: 'TaskStarted', payload: {} } as DomainEvent))
    bus.publish(envelope(taskId, seq++, { type: 'MessageStarted', payload: { messageId: 'M1' } } as DomainEvent))
    bus.publish(envelope(taskId, seq++, { type: 'TaskFailed', payload: { error: { message: 'boom' } } } as DomainEvent))

    const events = await eventsPromise
    const types = events.map((e) => e.type)
    expect(types.indexOf('TEXT_MESSAGE_END')).toBeGreaterThan(-1)
    expect(types.indexOf('RUN_ERROR')).toBeGreaterThan(-1)
    expect(types.indexOf('TEXT_MESSAGE_END')).toBeLessThan(types.indexOf('RUN_ERROR'))
    expect(sink.entries.some((e) => e.level === 'error')).toBe(true)
  })

  it('I3 取消路径含 thinking：REASONING_END 与 TEXT_MESSAGE_END 均在 RUN_FINISHED 之前', async () => {
    const { bus, sink, taskId, eventsPromise } = bootstrapRun()
    let seq = 1
    bus.publish(envelope(taskId, seq++, { type: 'TaskStarted', payload: {} } as DomainEvent))
    bus.publish(envelope(taskId, seq++, { type: 'MessageStarted', payload: { messageId: 'M1' } } as DomainEvent))
    bus.publish(envelope(taskId, seq++, { type: 'MessageDelta', payload: { messageId: 'M1', channel: 'thinking', payload: { content: '...' } } } as DomainEvent))
    bus.publish(envelope(taskId, seq++, { type: 'TaskCancelled', payload: {} } as DomainEvent))

    const events = await eventsPromise
    const types = events.map((e) => e.type)
    const finishedIdx = types.indexOf('RUN_FINISHED')
    expect(finishedIdx).toBeGreaterThan(-1)
    expect(types.indexOf('REASONING_END')).toBeLessThan(finishedIdx)
    expect(types.indexOf('TEXT_MESSAGE_END')).toBeLessThan(finishedIdx)
    expect(sink.entries.some((e) => e.level === 'error')).toBe(true)
  })

  it('I4 空内容 TaskCompleted：兜底文本 START/CONTENT/END 齐全，gate 无泄漏', async () => {
    const { bus, sink, taskId, eventsPromise } = bootstrapRun()
    let seq = 1
    bus.publish(envelope(taskId, seq++, { type: 'TaskStarted', payload: {} } as DomainEvent))
    bus.publish(envelope(taskId, seq++, { type: 'TaskCompleted', payload: {} } as DomainEvent))

    const events = await eventsPromise
    const types = events.map((e) => e.type)
    expect(types).toContain('TEXT_MESSAGE_START')
    expect(types).toContain('TEXT_MESSAGE_CONTENT')
    expect(types).toContain('TEXT_MESSAGE_END')
    expect(types[types.length - 1]).toBe('RUN_FINISHED')
    expect(sink.entries.some((e) => e.level === 'error')).toBe(false)
  })
})
```

注意：
- `envelope()` helper 完整字段（包含 `correlationId` / `causationId` / `source` / ISO `occurredAt`）来自 `apps/controlplane/src/agents/__tests__/event-mapper.test.ts:17-30` 的风格，直接对齐。若执行时类型仍不符，读 `packages/shared/src/events/envelope.ts`（或等价文件）修对应字段即可。
- `DomainEvent` 的 `type` 与 `payload` 的 shape 走 `as DomainEvent` 断言，避免 plan 里硬编码完整联合类型。

- [ ] **Step 7.3：跑集成测试确认失败**

```
pnpm --filter @tianji/controlplane test -- tianji-agent.gate
```

期望：fail，`TianjiAgent` 构造只接受 4 个参数且行为与断言不符。

- [ ] **Step 7.4：修改 tianji-agent.ts**

顶部新增 import：

```ts
import type { ObserverLogger } from '@tianji/observer'

import { AgUiEventGate, isTerminalAgUiEvent } from './ag-ui-event-gate.js'
```

class 字段 + 构造：

```ts
readonly #db: ControlPlaneDb
readonly #nodeId: string
readonly #cpAgentId: string
readonly #bus: EventBus | undefined
readonly #logger: ObserverLogger

constructor(
  db: ControlPlaneDb,
  nodeId: string,
  agentId: string,
  bus: EventBus | undefined,
  logger: ObserverLogger,
) {
  super({ description: `Tianji agent for node ${nodeId}` })
  this.#db = db
  this.#nodeId = nodeId
  this.#cpAgentId = agentId
  this.#bus = bus
  this.#logger = logger
}
```

`logger` 为必传，无默认兜底（遵循 CLAUDE.md "Let it crash"；装配层必须注入）。

`run()` 里 `ctx` 之后的订阅部分替换：

```ts
const ctx: EventMapperContext = { inThinking: false, taskId }
let hasTextMessage = false
const gate = new AgUiEventGate(subscriber, { runId, threadId }, this.#logger)

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const subscription: SubscriptionHandle = this.#bus!.subscribe(
  { aggregateId: taskId },
  (env) => {
    const frames = mapToAgUi(env, ctx)
    for (const f of frames) {
      if (isTerminalAgUiEvent(f)) gate.emitTerminal(f)
      else gate.emit(f)
      if (f.type === EventType.TEXT_MESSAGE_START) hasTextMessage = true
    }

    if (TERMINAL_TASK_TYPES.has(env.type)) {
      if (!hasTextMessage && env.type === 'TaskCompleted') {
        const fbMsgId = `fallback-${taskId}`
        gate.emit({ type: EventType.TEXT_MESSAGE_START, messageId: fbMsgId, role: 'assistant' } as BaseEvent)
        gate.emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: fbMsgId, delta: '任务已完成' } as BaseEvent)
        gate.emit({ type: EventType.TEXT_MESSAGE_END, messageId: fbMsgId } as BaseEvent)
      }

      if (!gate.alreadyTerminated()) {
        if (env.type === 'TaskCompleted' || env.type === 'TaskCancelled') {
          gate.emitTerminal({
            type: EventType.RUN_FINISHED,
            threadId,
            runId,
            ...(env.type === 'TaskCancelled' ? { reason: 'cancelled' } : {}),
          } as BaseEvent)
        } else {
          gate.emitTerminal({
            type: EventType.RUN_ERROR,
            message: `Task ${env.type}`,
          } as BaseEvent)
        }
      }

      subscription.unsubscribe()
      gate.dispose()
      subscriber.complete()
    }
  },
  { name: 'ag-ui-adapter', queueSize: 10_000 },
)
```

`Subscriber` wrapper 去掉——rxjs `Subscriber<BaseEvent>` 的 `.next(event)` 结构上满足 gate 的 `Subscriber` interface。

同步要删：
- `let sawTerminalAgUiEvent = false`
- 原 `for` 循环里 `if (f.type === EventType.RUN_FINISHED || f.type === EventType.RUN_ERROR)` 的赋值
- 原 `if (!sawTerminalAgUiEvent)` 分支内所有直接 `subscriber.next(...)`

`clone()`：

```ts
clone(): TianjiAgent {
  return new TianjiAgent(this.#db, this.#nodeId, this.#cpAgentId, this.#bus, this.#logger)
}
```

- [ ] **Step 7.5：修改 copilot.ts 与 app.ts**

`apps/controlplane/src/routes/copilot.ts`：

```ts
import type { ObserverLogger } from '@tianji/observer'
// ... 原有 import

export function createCopilotRoute(
  db: ControlPlaneDb,
  logger: ObserverLogger,
  bus?: EventBus,
): Hono {
  // ...
  // 原 `new TianjiAgent(db, nodeId, agentId, bus)` 改为：
  const agent = new TianjiAgent(db, nodeId, agentId, bus, logger)
  // ...
  // 另一处 `new TianjiAgent(db, '', '', bus)` 改为：
  const agent = new TianjiAgent(db, '', '', bus, logger)
}
```

`apps/controlplane/src/app.ts:76` 改为：

```ts
app.route('/', createCopilotRoute(db, logger, bus))
```

- [ ] **Step 7.6：修改既有测试的构造签名**

`apps/controlplane/src/agents/__tests__/tianji-agent.test.ts`：文件顶部加 helper：

```ts
import { createMemorySink, createObserverLogger } from '@tianji/observer'

function makeTestLogger() {
  return createObserverLogger({ sinks: [createMemorySink()] })
}
```

把每处 `new TianjiAgent(db, 'node-1', 'agent-1')` 改为 `new TianjiAgent(db, 'node-1', 'agent-1', undefined, makeTestLogger())`；`new TianjiAgent(db, 'node-1', 'agent-1', bus)` 改为 `new TianjiAgent(db, 'node-1', 'agent-1', bus, makeTestLogger())`。

`apps/controlplane/src/routes/__tests__/copilot.test.ts:17, 142` 把 `createCopilotRoute(db)` 改为 `createCopilotRoute(db, makeTestLogger())`（同样加 helper 或 import 共享的）。

- [ ] **Step 7.7：跑所有相关测试**

```
pnpm --filter @tianji/controlplane test -- tianji-agent
pnpm --filter @tianji/controlplane test -- copilot
```

期望：`tianji-agent.test.ts`（老）继续 PASS，`tianji-agent.gate.integration.test.ts` 全部 PASS，`copilot.test.ts` 继续 PASS。

若 I 类测试失败，按顺序排查：
1. `DomainEventEnvelope` 字段与 schema 不符 → 读 `packages/shared/src/events/envelope.ts` 对比，修 `envelope()` helper 里的字段
2. `eventsPromise` 在 `TaskCancelled` 路径下没收到 complete → 检查 `tianji-agent.ts` 的订阅回调是否正确调用了 `subscriber.complete()`

- [ ] **Step 7.8：commit**

---

## Task 8：回归 + pnpm check

**目标：** 确认 gate 不破坏 `tianji-agent.test.ts`、`event-mapper.test.ts`、`copilot.test.ts` 的既有用例；修复所有类型/lint 问题。

- [ ] **Step 8.1：跑 controlplane 全部测试**

```
pnpm --filter @tianji/controlplane test
```

期望：全绿。

- [ ] **Step 8.2：仓库根跑 check**

```
pnpm check
```

保留完整输出，不截断。修完所有 error / warn / info。

- [ ] **Step 8.3：commit**

---

## Task 9：端到端手工验证（可选但强烈建议）

- [ ] **Step 9.1：用户本地启动 controlplane + node**

（agent 不执行 `pnpm dev`，由用户启动，agent 观察日志。）

- [ ] **Step 9.2：触发一次 TaskFailed 或 TaskCancelled 路径**

从前端发一次会产出文本消息、未等完成就被打断的任务。

- [ ] **Step 9.3：确认**

1. 浏览器控制台不再出现 `Cannot send 'RUN_FINISHED' while text messages are still active`。
2. controlplane 日志出现 `active text messages on terminal, flushed`（error 级别），携带 `runId` / `threadId` / `messageIds`。
3. 前端消息气泡正常收束。

若任一条不满足，回 Task 7 检查 gate 装配路径。

---

## 自检：Spec 覆盖映射

| spec 章节 | 计划任务 |
|---|---|
| §4 总架构 | Task 1 + Task 7 |
| §5.1 接口 | Task 1 |
| §5.2 内部状态（含 `hasText` 扩展） | Task 1 + Task 2 |
| §5.3 emit 事件类型处理 | Task 2 |
| §5.4 emitTerminal flush | Task 3 + Task 4 |
| §5.5 emit 终态后防御 | Task 2 + Task 5 |
| §5.6 dispose 兜底 | Task 6 |
| §6.1–§6.3 三种终态数据流 | Task 7 I1–I4 |
| §7 tianji-agent 迁移 | Task 7 |
| §8 错误处理表 | Task 3 + Task 5 + Task 6 |
| §9.1 单测 T1–T8 | T1/T2/T4 → Task 3；T3/T8 → Task 4；T5/T6 → Task 5；T7 → Task 6 |
| §9.2 集成 I1–I4 | Task 7.2 |
| §10 风险 1 inThinking 漂移 | T3/T8 锁定 |
| §10 风险 2 多活跃 | T4 锁定 |
| §10 风险 3 重复终态 | T5 锁定 |

**与 spec 的偏离：** 本计划把 `ActiveEntry` 从 `{ inThinking }` 扩展为 `{ inThinking, hasText }`，`#flushActive` 分别按字段判断是否补 REASONING / TEXT 闭合。原因：spec §5.3 说 REASONING_START 先到 TEXT 未到是防御式分支，但 §5.4 flush 策略对此情况未明确；若 flush 时对 `hasText=false` 的条目仍发 `TEXT_MESSAGE_END`，会给前端一个它从未见过 START 的 END，违反 AG-UI 协议。T8 测试锁定新行为。

---

## Future Work（不在本次实现）

- `TianjiAgent` 构造 5 个位置参数 `(db, nodeId, agentId, bus, logger)` 已接近参数膨胀临界；`2026-04-16-command-poll-waiter.md` 计划再加第 6 个 `registry`。建议**下一个计划**把构造签名迁移到 options bag `constructor(opts: { db, nodeId, agentId, bus?, logger, registry? })`，涉及 `copilot.ts` 两处 + 10+ 处测试的同步调整。本计划不合并，保持最小 blast radius。
