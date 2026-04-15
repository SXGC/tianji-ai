# 阶段 02：进程内 EventBus 实现

> Spec：[../../specs/2026-04-14-event-bus-design.md](../../specs/2026-04-14-event-bus-design.md) §四.6
> 前置：阶段 01（需要 `DomainEventEnvelope`、`AggregateType`）
> 交付物：`packages/shared/src/bus/` 薄 pub/sub，含 filter 匹配、有界队列、慢订阅者 `SubscriberLag` 元事件、replay 抽象。

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 提供 < 200 行的进程内 EventBus；`publish` 同步只入订阅者队列；每订阅者独立有界队列并按顺序在 `queueMicrotask` 里执行 handler；队列满即丢弃事件并发一条 `SubscriberLag` 元事件到 **bus 外部 sink**（不回到自身队列避免循环）。

**Architecture:** `EventBusImpl` 内部 `Map<subscriptionId, SubscriberState>`；每个 `SubscriberState` 含 filter、handler、有界环形队列、进行中标志位。`publish` 遍历订阅者，按 filter 匹配后把 envelope 塞队列并触发调度。`replay` 是接口但不由 Bus 实现（由持有 `EventLogStore` 的调用者实现——Bus 只暴露签名），阶段 04 落地 sqlite 实现，阶段 05 把 store-backed replay 装到 Bus 上。

**Tech Stack:** 无第三方依赖，纯 TS。

---

## File Structure

- Create: `packages/shared/src/bus/types.ts`
- Create: `packages/shared/src/bus/filter.ts`
- Create: `packages/shared/src/bus/bus.ts`
- Create: `packages/shared/src/bus/meta-events.ts`
- Create: `packages/shared/src/bus/index.ts`
- Create: `packages/shared/src/bus/__tests__/filter.test.ts`
- Create: `packages/shared/src/bus/__tests__/bus.test.ts`
- Modify: `packages/shared/src/index.ts`（新增 bus 子模块 re-export）

---

### Task 1: Bus 公共类型

**Files:**
- Create: `packages/shared/src/bus/types.ts`

- [ ] **Step 1: 写 types.ts**

```ts
/**
 * EventBus 公共类型定义。
 * @module bus/types
 */

import type { DomainEvent } from '../events/domain-event.js'
import type { AggregateType, DomainEventEnvelope } from '../events/envelope.js'

export interface EventFilter {
  readonly aggregateType?: readonly AggregateType[]
  readonly aggregateId?: string
  readonly correlationId?: string
  readonly type?: readonly string[]
}

export interface SubscriptionHandle {
  unsubscribe(): void
}

export type EventHandler = (env: DomainEventEnvelope) => void | Promise<void>

export interface SubscribeOptions {
  readonly name: string
  readonly queueSize?: number
}

export interface EventBus {
  publish(env: DomainEventEnvelope): void
  subscribe(
    filter: EventFilter,
    handler: EventHandler,
    options: SubscribeOptions,
  ): SubscriptionHandle
  replay(filter: EventFilter, fromSequence?: number): AsyncIterable<DomainEventEnvelope>
}

export interface LagSink {
  (info: {
    subscriberName: string
    droppedEventId: string
    droppedEventType: string
    queueSize: number
    occurredAt: string
  }): void
}

export type _UnusedDomainEvent = DomainEvent
```

- [ ] **Step 2: 提交**

```bash
git add packages/shared/src/bus/types.ts
git commit -m "feat(shared): 定义 EventBus 公共类型与 LagSink"
```

---

### Task 2: Filter 匹配（TDD）

**Files:**
- Create: `packages/shared/src/bus/filter.ts`
- Create: `packages/shared/src/bus/__tests__/filter.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
// packages/shared/src/bus/__tests__/filter.test.ts
import { describe, expect, it } from 'vitest'
import { matchFilter } from '../filter.js'
import type { DomainEventEnvelope } from '../../events/envelope.js'

function env(overrides: Partial<DomainEventEnvelope>): DomainEventEnvelope {
  return {
    eventId: 'e1',
    type: 'RunStarted',
    occurredAt: '2026-04-14T00:00:00Z',
    correlationId: 'c1',
    causationId: null,
    sequence: 1,
    aggregateType: 'Run',
    aggregateId: 'r1',
    source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
    payload: {} as never,
    ...overrides,
  } as DomainEventEnvelope
}

describe('matchFilter', () => {
  it('空 filter 匹配任意 envelope', () => {
    expect(matchFilter({}, env({}))).toBe(true)
  })

  it('aggregateType 列表过滤', () => {
    expect(matchFilter({ aggregateType: ['Run'] }, env({}))).toBe(true)
    expect(matchFilter({ aggregateType: ['Task'] }, env({}))).toBe(false)
  })

  it('aggregateId 精确匹配', () => {
    expect(matchFilter({ aggregateId: 'r1' }, env({}))).toBe(true)
    expect(matchFilter({ aggregateId: 'r2' }, env({}))).toBe(false)
  })

  it('correlationId 精确匹配', () => {
    expect(matchFilter({ correlationId: 'c1' }, env({}))).toBe(true)
    expect(matchFilter({ correlationId: 'c2' }, env({}))).toBe(false)
  })

  it('type 列表过滤', () => {
    expect(matchFilter({ type: ['RunStarted'] }, env({}))).toBe(true)
    expect(matchFilter({ type: ['RunFailed'] }, env({}))).toBe(false)
  })

  it('多条件 AND 组合', () => {
    const ok = env({})
    expect(
      matchFilter(
        { aggregateType: ['Run'], type: ['RunStarted'], correlationId: 'c1' },
        ok,
      ),
    ).toBe(true)
    expect(
      matchFilter(
        { aggregateType: ['Run'], type: ['RunFailed'], correlationId: 'c1' },
        ok,
      ),
    ).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @tianji/shared test -- filter.test.ts
```
Expected: FAIL，`../filter.js` 不存在。

- [ ] **Step 3: 实现 filter.ts**

```ts
/**
 * EventBus filter 匹配。多条件 AND 组合。
 * @module bus/filter
 */

import type { DomainEventEnvelope } from '../events/envelope.js'
import type { EventFilter } from './types.js'

export function matchFilter(filter: EventFilter, env: DomainEventEnvelope): boolean {
  if (filter.aggregateType && !filter.aggregateType.includes(env.aggregateType)) return false
  if (filter.aggregateId !== undefined && filter.aggregateId !== env.aggregateId) return false
  if (filter.correlationId !== undefined && filter.correlationId !== env.correlationId) return false
  if (filter.type && !filter.type.includes(env.type)) return false
  return true
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @tianji/shared test -- filter.test.ts
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/bus/filter.ts packages/shared/src/bus/__tests__/filter.test.ts
git commit -m "feat(shared): 实现 EventBus filter 匹配"
```

---

### Task 3: 元事件 SubscriberLag

**Files:**
- Create: `packages/shared/src/bus/meta-events.ts`

- [ ] **Step 1: 写 meta-events.ts**

```ts
/**
 * Bus 内部元事件（不进 event_log，避免循环）。
 * @module bus/meta-events
 */

export interface SubscriberLagNotice {
  readonly subscriberName: string
  readonly droppedEventId: string
  readonly droppedEventType: string
  readonly queueSize: number
  readonly occurredAt: string
}
```

- [ ] **Step 2: 提交**

```bash
git add packages/shared/src/bus/meta-events.ts
git commit -m "feat(shared): 新增 SubscriberLag 元事件类型"
```

---

### Task 4: EventBus 核心（TDD）

**Files:**
- Create: `packages/shared/src/bus/bus.ts`
- Create: `packages/shared/src/bus/__tests__/bus.test.ts`

- [ ] **Step 1: 写失败的测试（见下块——先添加以下 6 个场景）**

```ts
// packages/shared/src/bus/__tests__/bus.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createEventBus } from '../bus.js'
import type { DomainEventEnvelope } from '../../events/envelope.js'

function mk(overrides: Partial<DomainEventEnvelope>): DomainEventEnvelope {
  return {
    eventId: overrides.eventId ?? 'e?',
    type: overrides.type ?? 'RunStarted',
    occurredAt: '2026-04-14T00:00:00Z',
    correlationId: overrides.correlationId ?? 'c1',
    causationId: null,
    sequence: overrides.sequence ?? 1,
    aggregateType: overrides.aggregateType ?? 'Run',
    aggregateId: overrides.aggregateId ?? 'r1',
    source: { processKind: 'node', processId: 'p1' },
    payload: {} as never,
  } as DomainEventEnvelope
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()))

describe('EventBus', () => {
  it('publish 同步返回，handler 异步执行', async () => {
    const bus = createEventBus({ lagSink: vi.fn() })
    const seen: string[] = []
    bus.subscribe({}, (env) => { seen.push(env.eventId) }, { name: 's1' })
    bus.publish(mk({ eventId: 'e1' }))
    expect(seen).toEqual([])
    await flush()
    expect(seen).toEqual(['e1'])
  })

  it('按 filter 投递', async () => {
    const bus = createEventBus({ lagSink: vi.fn() })
    const taskSeen: string[] = []
    bus.subscribe(
      { aggregateType: ['Task'] },
      (env) => { taskSeen.push(env.eventId) },
      { name: 'task-sub' },
    )
    bus.publish(mk({ eventId: 'e1', aggregateType: 'Run' }))
    bus.publish(mk({ eventId: 'e2', aggregateType: 'Task', aggregateId: 't1' }))
    await flush(); await flush()
    expect(taskSeen).toEqual(['e2'])
  })

  it('订阅者顺序执行 handler', async () => {
    const bus = createEventBus({ lagSink: vi.fn() })
    const order: string[] = []
    bus.subscribe({}, async (env) => { order.push(`in:${env.eventId}`); await Promise.resolve(); order.push(`out:${env.eventId}`) }, { name: 's1' })
    bus.publish(mk({ eventId: 'e1' }))
    bus.publish(mk({ eventId: 'e2' }))
    for (let i = 0; i < 5; i++) await flush()
    expect(order).toEqual(['in:e1', 'out:e1', 'in:e2', 'out:e2'])
  })

  it('队列满丢弃并调用 lagSink', async () => {
    const lag = vi.fn()
    const bus = createEventBus({ lagSink: lag })
    bus.subscribe({}, async () => { await new Promise((r) => setTimeout(r, 10)) }, { name: 'slow', queueSize: 2 })
    bus.publish(mk({ eventId: 'e1' }))
    bus.publish(mk({ eventId: 'e2' }))
    bus.publish(mk({ eventId: 'e3' }))
    expect(lag).toHaveBeenCalledTimes(1)
    expect(lag.mock.calls[0][0]).toMatchObject({ subscriberName: 'slow', droppedEventId: 'e3' })
  })

  it('unsubscribe 后不再投递', async () => {
    const bus = createEventBus({ lagSink: vi.fn() })
    const seen: string[] = []
    const sub = bus.subscribe({}, (env) => { seen.push(env.eventId) }, { name: 's1' })
    sub.unsubscribe()
    bus.publish(mk({ eventId: 'e1' }))
    await flush()
    expect(seen).toEqual([])
  })

  it('handler throw 不阻断其他订阅者', async () => {
    const bus = createEventBus({ lagSink: vi.fn() })
    const err = vi.fn()
    const ok: string[] = []
    bus.subscribe({}, () => { throw new Error('boom') }, { name: 'bad' })
    bus.subscribe({}, (env) => { ok.push(env.eventId) }, { name: 'good' })
    bus.publish(mk({ eventId: 'e1' }))
    await flush(); await flush()
    expect(ok).toEqual(['e1'])
    void err
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @tianji/shared test -- bus.test.ts
```
Expected: FAIL，`../bus.js` 不存在。

- [ ] **Step 3: 实现 bus.ts**

```ts
/**
 * 进程内薄 pub/sub EventBus。
 * publish 同步返回；每订阅者独立有界队列；队列满丢事件并发 lagSink。
 * replay 留给调用方注入 store-backed 实现（阶段 05）。
 * @module bus/bus
 */

import type { DomainEventEnvelope } from '../events/envelope.js'
import { matchFilter } from './filter.js'
import type {
  EventBus,
  EventFilter,
  EventHandler,
  LagSink,
  SubscribeOptions,
  SubscriptionHandle,
} from './types.js'

interface Subscriber {
  readonly id: number
  readonly name: string
  readonly filter: EventFilter
  readonly handler: EventHandler
  readonly queueSize: number
  readonly queue: DomainEventEnvelope[]
  running: boolean
  cancelled: boolean
}

const DEFAULT_QUEUE_SIZE = 1024

export interface EventBusOptions {
  readonly lagSink: LagSink
  readonly replaySource?: (
    filter: EventFilter,
    fromSequence?: number,
  ) => AsyncIterable<DomainEventEnvelope>
}

export function createEventBus(options: EventBusOptions): EventBus {
  const subscribers = new Map<number, Subscriber>()
  let nextId = 1

  function publish(env: DomainEventEnvelope): void {
    for (const sub of subscribers.values()) {
      if (sub.cancelled) continue
      if (!matchFilter(sub.filter, env)) continue
      if (sub.queue.length >= sub.queueSize) {
        options.lagSink({
          subscriberName: sub.name,
          droppedEventId: env.eventId,
          droppedEventType: env.type,
          queueSize: sub.queueSize,
          occurredAt: env.occurredAt,
        })
        continue
      }
      sub.queue.push(env)
      schedule(sub)
    }
  }

  function schedule(sub: Subscriber): void {
    if (sub.running) return
    sub.running = true
    queueMicrotask(() => { void drain(sub) })
  }

  async function drain(sub: Subscriber): Promise<void> {
    while (!sub.cancelled && sub.queue.length > 0) {
      const env = sub.queue.shift() as DomainEventEnvelope
      try {
        await sub.handler(env)
      } catch {
        // handler 异常吞掉，不中断订阅者；由 handler 自身负责 error 日志
      }
    }
    sub.running = false
  }

  function subscribe(
    filter: EventFilter,
    handler: EventHandler,
    opts: SubscribeOptions,
  ): SubscriptionHandle {
    const id = nextId++
    const sub: Subscriber = {
      id,
      name: opts.name,
      filter,
      handler,
      queueSize: opts.queueSize ?? DEFAULT_QUEUE_SIZE,
      queue: [],
      running: false,
      cancelled: false,
    }
    subscribers.set(id, sub)
    return {
      unsubscribe(): void {
        sub.cancelled = true
        subscribers.delete(id)
      },
    }
  }

  async function* replay(
    filter: EventFilter,
    fromSequence?: number,
  ): AsyncIterable<DomainEventEnvelope> {
    if (!options.replaySource) {
      throw new Error('EventBus.replay: 未配置 replaySource')
    }
    for await (const env of options.replaySource(filter, fromSequence)) {
      yield env
    }
  }

  return { publish, subscribe, replay }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @tianji/shared test -- bus.test.ts
```
Expected: PASS。若 "handler throw 不阻断" 失败，检查 try/catch 是否包住 `await sub.handler`。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/bus/bus.ts packages/shared/src/bus/__tests__/bus.test.ts
git commit -m "feat(shared): 实现进程内 EventBus 薄 pub/sub"
```

---

### Task 5: 子模块 index 与根导出

**Files:**
- Create: `packages/shared/src/bus/index.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 写 bus/index.ts**

```ts
export * from './bus.js'
export * from './filter.js'
export * from './meta-events.js'
export * from './types.js'
```

- [ ] **Step 2: 在 `packages/shared/src/index.ts` 中新增：**

```ts
export * from './bus/index.js'
```

- [ ] **Step 3: 跑 check**

```bash
pnpm check
```
Expected: 全绿。

- [ ] **Step 4: 提交**

```bash
git add packages/shared/src/bus/index.ts packages/shared/src/index.ts
git commit -m "feat(shared): 导出 EventBus 子模块"
```

---

## Self-Review Checklist

- [ ] bus.ts < 200 行。
- [ ] `publish` 同步返回，不 await handler。
- [ ] 队列满调 `lagSink` 而不是再 `publish`（避免循环）。
- [ ] handler 异常不中断订阅者。
- [ ] `unsubscribe` 幂等，删除后 publish 不再投递。
- [ ] 无 `any` / 无 `import()` / < 800 行。
- [ ] `pnpm check` 全绿。
