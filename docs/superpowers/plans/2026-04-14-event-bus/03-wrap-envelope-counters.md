# 阶段 03：wrapEnvelope、聚合计数器、重启恢复

> Spec：[../../specs/2026-04-14-event-bus-design.md](../../specs/2026-04-14-event-bus-design.md) §四.1–§四.5、§四.7
> 前置：阶段 01（envelope 类型）
> 交付物：`packages/runtime/src/bus/` 装配层，提供 `createEnvelopeWrapper`、`SequenceCounter`、`CausalContext` 与 `SequenceRecoverer` 接口。

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 给 runtime/装配层提供一个把裸 `DomainEvent` 转成带 envelope 的回调工厂，封装 ULID 生成、correlationId/causationId 上下文继承、聚合实例计数器 `sequence` 单调递增，以及从外部 `SequenceRecoverer` 初始化计数器。

**Architecture:** 三个可单测组件：
1. `SequenceCounter` — 进程内内存 `Map<key, number>`；`next(key)` 返回并自增；`init(key, from)` 一次性初始化（第二次 init 同一 key throw）。
2. `CausalContext` — 小工具类。`root(correlationId)` / `child(causationEventId)` 返回新快照；快照是不可变对象。
3. `createEnvelopeWrapper(deps)` — 工厂，返回 `wrap(event, target): DomainEventEnvelope`，按 event.type → aggregateType/aggregateId 规则生成信封。
4. `SequenceRecoverer` — 接口：`maxSequence(aggregateType, aggregateId): Promise<number | null>`，由阶段 04 的 sqlite 实现提供，阶段 05 装配时注入。

**Tech Stack:** `ulid` npm 包；TypeScript；vitest。

---

## File Structure

- Modify: `packages/runtime/package.json`（新增 `ulid` 依赖）
- Create: `packages/runtime/src/bus/sequence-counter.ts`
- Create: `packages/runtime/src/bus/causal-context.ts`
- Create: `packages/runtime/src/bus/event-target.ts`
- Create: `packages/runtime/src/bus/envelope-wrapper.ts`
- Create: `packages/runtime/src/bus/sequence-recoverer.ts`
- Create: `packages/runtime/src/bus/index.ts`
- Create: `packages/runtime/src/bus/__tests__/sequence-counter.test.ts`
- Create: `packages/runtime/src/bus/__tests__/causal-context.test.ts`
- Create: `packages/runtime/src/bus/__tests__/envelope-wrapper.test.ts`
- Modify: `packages/runtime/src/index.ts`（re-export bus 子模块）

---

### Task 1: 加 ulid 依赖

**Files:**
- Modify: `packages/runtime/package.json`

- [ ] **Step 1: 征求用户许可**：若仓库未安装 `ulid`，向用户确认"加入 `ulid@^2` 依赖"。根据 CLAUDE.md "任何环境变量的添加都需要明确让用户同意"的原则外推：新依赖同样需确认。

- [ ] **Step 2: 通过后执行**

```bash
pnpm --filter @tianji/runtime add ulid
```

- [ ] **Step 3: 提交**

```bash
git add packages/runtime/package.json pnpm-lock.yaml
git commit -m "chore(runtime): 新增 ulid 依赖用于 envelope eventId"
```

---

### Task 2: SequenceCounter（TDD）

**Files:**
- Create: `packages/runtime/src/bus/sequence-counter.ts`
- Create: `packages/runtime/src/bus/__tests__/sequence-counter.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/runtime/src/bus/__tests__/sequence-counter.test.ts
import { describe, expect, it } from 'vitest'
import { SequenceCounter } from '../sequence-counter.js'

describe('SequenceCounter', () => {
  it('未初始化的 key 第一个 next() 返回 1', () => {
    const c = new SequenceCounter()
    expect(c.next('Run:r1')).toBe(1)
    expect(c.next('Run:r1')).toBe(2)
  })

  it('init 后从 init+1 继续', () => {
    const c = new SequenceCounter()
    c.init('Run:r1', 10)
    expect(c.next('Run:r1')).toBe(11)
  })

  it('同一 key 二次 init throw', () => {
    const c = new SequenceCounter()
    c.init('Run:r1', 5)
    expect(() => c.init('Run:r1', 6)).toThrow(/already initialized/)
  })

  it('不同 key 互不影响', () => {
    const c = new SequenceCounter()
    c.next('Run:r1')
    expect(c.next('Run:r2')).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @tianji/runtime test -- sequence-counter.test.ts
```
Expected: FAIL（文件不存在）。

- [ ] **Step 3: 实现**

```ts
/**
 * 聚合实例 sequence 内存计数器。
 * key = `${aggregateType}:${aggregateId}`。
 * @module bus/sequence-counter
 */

export class SequenceCounter {
  private readonly counters = new Map<string, number>()
  private readonly initialized = new Set<string>()

  init(key: string, from: number): void {
    if (this.initialized.has(key)) {
      throw new Error(`SequenceCounter: key already initialized: ${key}`)
    }
    this.initialized.add(key)
    this.counters.set(key, from)
  }

  next(key: string): number {
    const current = this.counters.get(key) ?? 0
    const nextVal = current + 1
    this.counters.set(key, nextVal)
    return nextVal
  }
}
```

- [ ] **Step 4: 跑测试通过**

```bash
pnpm --filter @tianji/runtime test -- sequence-counter.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add packages/runtime/src/bus/sequence-counter.ts packages/runtime/src/bus/__tests__/sequence-counter.test.ts
git commit -m "feat(runtime): 新增 SequenceCounter 支持聚合内 sequence 单调递增"
```

---

### Task 3: CausalContext（TDD）

**Files:**
- Create: `packages/runtime/src/bus/causal-context.ts`
- Create: `packages/runtime/src/bus/__tests__/causal-context.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/runtime/src/bus/__tests__/causal-context.test.ts
import { describe, expect, it } from 'vitest'
import { CausalContext } from '../causal-context.js'

describe('CausalContext', () => {
  it('root 设置 correlationId 且 causationId 为 null', () => {
    const ctx = CausalContext.root('corr_1')
    expect(ctx.correlationId).toBe('corr_1')
    expect(ctx.causationId).toBeNull()
  })

  it('child 继承 correlationId 并把 causationId 设为传入 eventId', () => {
    const root = CausalContext.root('corr_1')
    const child = root.child('evt_1')
    expect(child.correlationId).toBe('corr_1')
    expect(child.causationId).toBe('evt_1')
  })

  it('child 不修改父上下文', () => {
    const root = CausalContext.root('corr_1')
    root.child('evt_1')
    expect(root.causationId).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试失败**

```bash
pnpm --filter @tianji/runtime test -- causal-context.test.ts
```

- [ ] **Step 3: 实现**

```ts
/**
 * 因果链上下文快照。不可变。
 * @module bus/causal-context
 */

export class CausalContext {
  private constructor(
    public readonly correlationId: string,
    public readonly causationId: string | null,
  ) {}

  static root(correlationId: string): CausalContext {
    return new CausalContext(correlationId, null)
  }

  child(causationEventId: string): CausalContext {
    return new CausalContext(this.correlationId, causationEventId)
  }
}
```

- [ ] **Step 4: 跑测试通过 + 提交**

```bash
pnpm --filter @tianji/runtime test -- causal-context.test.ts
git add packages/runtime/src/bus/causal-context.ts packages/runtime/src/bus/__tests__/causal-context.test.ts
git commit -m "feat(runtime): 新增 CausalContext 承载 correlationId/causationId"
```

---

### Task 4: event-target 映射（给定事件得到 aggregateType + aggregateId）

**Files:**
- Create: `packages/runtime/src/bus/event-target.ts`

- [ ] **Step 1: 写 event-target.ts**

```ts
/**
 * 根据 DomainEvent 推导 envelope 的 aggregateType 与 aggregateId。
 * 纯函数，便于单测。
 * @module bus/event-target
 */

import type { AggregateType, DomainEvent } from '@tianji/shared'

export interface EventTarget {
  readonly aggregateType: AggregateType
  readonly aggregateId: string
}

export function resolveTarget(event: DomainEvent): EventTarget {
  switch (event.type) {
    case 'SessionCreated':
    case 'SessionResumed':
    case 'SessionClosed':
      return { aggregateType: 'Session', aggregateId: event.sessionId }

    case 'GraphRunStarted':
    case 'GraphRunCompleted':
    case 'GraphRunFailed':
    case 'GraphNodeStarted':
    case 'GraphNodeCompleted':
    case 'GraphNodeFailed':
      return { aggregateType: 'GraphRun', aggregateId: event.runId }

    case 'RunStarted':
    case 'RunCompleted':
    case 'RunFailed':
    case 'RunCancelled':
    case 'MessageStarted':
    case 'MessageDelta':
    case 'MessageCompleted':
    case 'ToolStarted':
    case 'ToolCompleted':
    case 'ToolFailed':
      return { aggregateType: 'Run', aggregateId: event.runId }

    case 'TaskStarted':
    case 'TaskWaiting':
    case 'TaskSessionAttached':
    case 'TaskCompleted':
    case 'TaskFailed':
    case 'TaskCancelled':
    case 'TaskObservationLost':
      return { aggregateType: 'Task', aggregateId: event.taskId }

    case 'NodeRegistered':
    case 'NodeReRegistered':
    case 'NodeMarkedOffline':
      return { aggregateType: 'Node', aggregateId: event.nodeId }
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add packages/runtime/src/bus/event-target.ts
git commit -m "feat(runtime): 新增 DomainEvent → aggregate 解析"
```

---

### Task 5: SequenceRecoverer 接口与 no-op 实现

**Files:**
- Create: `packages/runtime/src/bus/sequence-recoverer.ts`

- [ ] **Step 1: 写文件**

```ts
/**
 * 从持久化存储查单聚合 MAX(sequence)。由装配层在进程启动 / 接管聚合时调用。
 * sqlite 实现在阶段 04 controlplane 侧；runtime 装配时注入。
 * @module bus/sequence-recoverer
 */

import type { AggregateType } from '@tianji/shared'

export interface SequenceRecoverer {
  maxSequence(aggregateType: AggregateType, aggregateId: string): Promise<number | null>
}

export const NoopSequenceRecoverer: SequenceRecoverer = {
  async maxSequence(): Promise<number | null> {
    return null
  },
}
```

- [ ] **Step 2: 提交**

```bash
git add packages/runtime/src/bus/sequence-recoverer.ts
git commit -m "feat(runtime): 定义 SequenceRecoverer 接口与 Noop 实现"
```

---

### Task 6: createEnvelopeWrapper（TDD）

**Files:**
- Create: `packages/runtime/src/bus/envelope-wrapper.ts`
- Create: `packages/runtime/src/bus/__tests__/envelope-wrapper.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/runtime/src/bus/__tests__/envelope-wrapper.test.ts
import { describe, expect, it } from 'vitest'
import { createEnvelopeWrapper } from '../envelope-wrapper.js'
import { CausalContext } from '../causal-context.js'
import { SequenceCounter } from '../sequence-counter.js'
import { NoopSequenceRecoverer } from '../sequence-recoverer.js'

describe('createEnvelopeWrapper', () => {
  it('根事件：correlationId 注入、causationId=null、sequence=1', async () => {
    const counter = new SequenceCounter()
    const ctx = { current: CausalContext.root('corr_1') }
    const wrap = createEnvelopeWrapper({
      counter,
      context: ctx,
      source: { processKind: 'daemon', processId: 'p1' },
      recoverer: NoopSequenceRecoverer,
      now: () => '2026-04-14T00:00:00Z',
    })

    const env = await wrap({
      type: 'RunStarted',
      runId: 'r1',
      sessionId: 's1',
      triggerType: 'fresh',
      timestamp: 1,
    } as never)

    expect(env.type).toBe('RunStarted')
    expect(env.aggregateType).toBe('Run')
    expect(env.aggregateId).toBe('r1')
    expect(env.correlationId).toBe('corr_1')
    expect(env.causationId).toBeNull()
    expect(env.sequence).toBe(1)
    expect(env.occurredAt).toBe('2026-04-14T00:00:00Z')
    expect(env.source).toEqual({ processKind: 'daemon', processId: 'p1' })
    expect(typeof env.eventId).toBe('string')
    expect(env.eventId.length).toBeGreaterThan(10)
  })

  it('同聚合连续 wrap sequence 递增', async () => {
    const counter = new SequenceCounter()
    const ctx = { current: CausalContext.root('c1') }
    const wrap = createEnvelopeWrapper({
      counter, context: ctx,
      source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
      recoverer: NoopSequenceRecoverer,
      now: () => 'T',
    })
    const e1 = await wrap({ type: 'RunStarted', runId: 'r1', sessionId: 's1', triggerType: 'fresh', timestamp: 0 } as never)
    const e2 = await wrap({ type: 'MessageStarted', runId: 'r1', messageId: 'm1', message: {} as never, timestamp: 0 } as never)
    expect(e1.sequence).toBe(1)
    expect(e2.sequence).toBe(2)
  })

  it('首次发射时用 recoverer.maxSequence 初始化计数器', async () => {
    const counter = new SequenceCounter()
    const ctx = { current: CausalContext.root('c1') }
    const wrap = createEnvelopeWrapper({
      counter, context: ctx,
      source: { processKind: 'node', processId: 'p1' },
      recoverer: { async maxSequence() { return 10 } },
      now: () => 'T',
    })
    const env = await wrap({ type: 'RunStarted', runId: 'r1', sessionId: 's1', triggerType: 'fresh', timestamp: 0 } as never)
    expect(env.sequence).toBe(11)
  })
})
```

- [ ] **Step 2: 跑失败**

```bash
pnpm --filter @tianji/runtime test -- envelope-wrapper.test.ts
```

- [ ] **Step 3: 实现**

```ts
/**
 * Envelope wrapper 工厂。把裸 DomainEvent 包装成 DomainEventEnvelope。
 * 首次看到某 aggregate key 时调用 SequenceRecoverer 初始化计数器。
 * @module bus/envelope-wrapper
 */

import type { DomainEvent, DomainEventEnvelope, EnvelopeSource } from '@tianji/shared'
import { ulid } from 'ulid'
import { CausalContext } from './causal-context.js'
import { resolveTarget } from './event-target.js'
import { SequenceCounter } from './sequence-counter.js'
import type { SequenceRecoverer } from './sequence-recoverer.js'

export interface CausalContextRef {
  current: CausalContext
}

export interface EnvelopeWrapperDeps {
  readonly counter: SequenceCounter
  readonly context: CausalContextRef
  readonly source: EnvelopeSource
  readonly recoverer: SequenceRecoverer
  readonly now?: () => string
}

export function createEnvelopeWrapper(deps: EnvelopeWrapperDeps) {
  const seen = new Set<string>()
  const now = deps.now ?? (() => new Date().toISOString())

  return async function wrap(event: DomainEvent): Promise<DomainEventEnvelope> {
    const { aggregateType, aggregateId } = resolveTarget(event)
    const key = `${aggregateType}:${aggregateId}`

    if (!seen.has(key)) {
      seen.add(key)
      const max = await deps.recoverer.maxSequence(aggregateType, aggregateId)
      if (max !== null) deps.counter.init(key, max)
    }

    const sequence = deps.counter.next(key)
    const ctx = deps.context.current
    return {
      eventId: ulid(),
      type: event.type,
      occurredAt: now(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      sequence,
      aggregateType,
      aggregateId,
      source: deps.source,
      payload: event,
    }
  }
}
```

- [ ] **Step 4: 跑测试通过；若"connection 不到 ulid"，补 runtime 到 shared workspace 引用方式（应已存在）**

```bash
pnpm --filter @tianji/runtime test -- envelope-wrapper.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add packages/runtime/src/bus/envelope-wrapper.ts packages/runtime/src/bus/__tests__/envelope-wrapper.test.ts
git commit -m "feat(runtime): 实现 envelope wrapper 注入信封与 sequence 初始化"
```

---

### Task 7: bus 子模块 index 与导出

**Files:**
- Create: `packages/runtime/src/bus/index.ts`
- Modify: `packages/runtime/src/index.ts`

- [ ] **Step 1: 写 index.ts**

```ts
export * from './causal-context.js'
export * from './envelope-wrapper.js'
export * from './event-target.js'
export * from './sequence-counter.js'
export * from './sequence-recoverer.js'
```

- [ ] **Step 2: 打开 `packages/runtime/src/index.ts` 读取后追加：**

```ts
export * from './bus/index.js'
```

- [ ] **Step 3: `pnpm check` 全绿 → 提交**

```bash
git add packages/runtime/src/bus/index.ts packages/runtime/src/index.ts
git commit -m "feat(runtime): 导出 bus 装配子模块"
```

---

## Self-Review Checklist

- [ ] `SequenceCounter.init` 二次 init 同 key 直接 throw（Let it crash）。
- [ ] `envelope-wrapper` 只在首次看到 aggregate key 时调用 `recoverer`。
- [ ] `CausalContext` 不可变。
- [ ] `event-target.ts` 的 switch 覆盖所有 25 个事件类型（编译期穷尽 switch 应由 `never` 检查；本阶段用 switch 默认分支省略，TypeScript 在 strict 下会在遗漏时报错）。
- [ ] 所有文件 < 800 行，无 `any`，无内联 import。
