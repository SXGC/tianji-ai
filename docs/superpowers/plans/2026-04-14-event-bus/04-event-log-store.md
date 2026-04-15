# 阶段 04：event_log 表与 EventLogStore

> Spec：[../../specs/2026-04-14-event-bus-design.md](../../specs/2026-04-14-event-bus-design.md) §四.2、§四.4、§四.5
> 前置：阶段 01（envelope 类型）、阶段 03（`SequenceRecoverer` 接口）
> 交付物：`event_log` 表 schema 迁移；`EventLogStore` 接口（shared）；sqlite 实现（controlplane）；批量提交（50ms / 500 条）；从 event_log 实现 `SequenceRecoverer` 与 replay 源。

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 给事件提供持久化存储，落地 UNIQUE 约束（第二道防线），并提供 replay 与重启恢复的查询源。

**Architecture:**
- `EventLogStore` 接口（shared）：`append(env[])` 批量写；`maxSequence(agg, id)`；`queryByCorrelation(corr, fromSeq)`；`queryByAggregate(type, id, fromSeq)`。
- `SqliteEventLogStore` 实现（cp 侧）：基于 `apps/controlplane/src/db/database.ts` 的 better-sqlite3 handle；内部维护环形缓冲 + 定时 flush。
- `BatchCommitter`：50ms 定时 or 500 条阈值 flush。任一先到即触发。
- `event_log` 表 schema：Spec §四.4 原样。
- 从 store 适配出 `SequenceRecoverer` 与 `ReplaySource`。

**Tech Stack:** better-sqlite3（同仓已用）、vitest、`node:timers`。

---

## File Structure

- Create: `packages/shared/src/storage/event-log.ts`（store 接口 + types）
- Modify: `packages/shared/src/index.ts`（re-export storage）
- Modify: `apps/controlplane/src/db/schema.ts`（追加 event_log 表 SQL）
- Create: `apps/controlplane/src/storage/event-log-sqlite.ts`
- Create: `apps/controlplane/src/storage/batch-committer.ts`
- Create: `apps/controlplane/src/storage/event-log-recoverer.ts`
- Create: `apps/controlplane/src/storage/__tests__/event-log-sqlite.test.ts`
- Create: `apps/controlplane/src/storage/__tests__/batch-committer.test.ts`

---

### Task 1: EventLogStore 接口（shared）

**Files:**
- Create: `packages/shared/src/storage/event-log.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 写 event-log.ts**

```ts
/**
 * EventLogStore 接口：领域事件日志持久化抽象。
 * 实现侧在各 app 内落地（cp 用 sqlite）。
 * @module storage/event-log
 */

import type { AggregateType, DomainEventEnvelope } from '../events/envelope.js'

export interface EventLogAppendResult {
  readonly written: number
}

export interface EventLogStore {
  append(events: readonly DomainEventEnvelope[]): Promise<EventLogAppendResult>
  maxSequence(
    aggregateType: AggregateType,
    aggregateId: string,
  ): Promise<number | null>
  queryByAggregate(
    aggregateType: AggregateType,
    aggregateId: string,
    fromSequence?: number,
  ): AsyncIterable<DomainEventEnvelope>
  queryByCorrelation(
    correlationId: string,
    fromSequence?: number,
  ): AsyncIterable<DomainEventEnvelope>
}
```

- [ ] **Step 2: `packages/shared/src/index.ts` 追加：**

```ts
export * from './storage/event-log.js'
```

- [ ] **Step 3: 提交**

```bash
git add packages/shared/src/storage/event-log.ts packages/shared/src/index.ts
git commit -m "feat(shared): 定义 EventLogStore 接口"
```

---

### Task 2: event_log 表 schema

**Files:**
- Modify: `apps/controlplane/src/db/schema.ts`

- [ ] **Step 1: 读取整个 schema.ts，找到 `SCHEMA_SQL` 模板字面量尾部**

- [ ] **Step 2: 在 `SCHEMA_SQL` 末尾追加（注意放在 template literal 内闭合反引号之前）：**

```sql
CREATE TABLE IF NOT EXISTS event_log (
  event_id       TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id   TEXT,
  sequence       INTEGER NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  source_json    TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  UNIQUE(aggregate_type, aggregate_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_event_log_correlation ON event_log(correlation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_event_log_aggregate ON event_log(aggregate_type, aggregate_id, sequence);
CREATE INDEX IF NOT EXISTS idx_event_log_occurred_at ON event_log(occurred_at);
```

- [ ] **Step 3: 验证 schema.ts 无其他变更**

```bash
pnpm --filter @tianji/controlplane test -- schema
```
Expected：若没有对应 schema 测试则跳过；若有，verify 新表建得出来。

- [ ] **Step 4: 提交**

```bash
git add apps/controlplane/src/db/schema.ts
git commit -m "feat(controlplane): 新增 event_log 表与索引"
```

---

### Task 3: BatchCommitter（TDD）

**Files:**
- Create: `apps/controlplane/src/storage/batch-committer.ts`
- Create: `apps/controlplane/src/storage/__tests__/batch-committer.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// apps/controlplane/src/storage/__tests__/batch-committer.test.ts
import { describe, expect, it, vi } from 'vitest'
import { BatchCommitter } from '../batch-committer.js'

describe('BatchCommitter', () => {
  it('到达 maxItems 立即 flush', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const c = new BatchCommitter<number>({ maxItems: 3, flushIntervalMs: 10_000, flush })
    c.push(1); c.push(2)
    expect(flush).not.toHaveBeenCalled()
    c.push(3)
    await Promise.resolve()
    expect(flush).toHaveBeenCalledWith([1, 2, 3])
    c.dispose()
  })

  it('到达 flushIntervalMs 触发 flush', async () => {
    vi.useFakeTimers()
    const flush = vi.fn().mockResolvedValue(undefined)
    const c = new BatchCommitter<number>({ maxItems: 100, flushIntervalMs: 50, flush })
    c.push(7)
    vi.advanceTimersByTime(50)
    await Promise.resolve()
    expect(flush).toHaveBeenCalledWith([7])
    c.dispose()
    vi.useRealTimers()
  })

  it('dispose 前还有 buffer 时 flushSync', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const c = new BatchCommitter<number>({ maxItems: 100, flushIntervalMs: 10_000, flush })
    c.push(1)
    await c.dispose()
    expect(flush).toHaveBeenCalledWith([1])
  })
})
```

- [ ] **Step 2: 跑失败**

```bash
pnpm --filter @tianji/controlplane test -- batch-committer.test.ts
```

- [ ] **Step 3: 实现**

```ts
/**
 * 批量提交器：maxItems 满 or flushIntervalMs 到，触发 flush。
 * @module storage/batch-committer
 */

export interface BatchCommitterOptions<T> {
  readonly maxItems: number
  readonly flushIntervalMs: number
  readonly flush: (items: readonly T[]) => Promise<void>
}

export class BatchCommitter<T> {
  private buffer: T[] = []
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly options: BatchCommitterOptions<T>) {}

  push(item: T): void {
    if (this.disposed) throw new Error('BatchCommitter: already disposed')
    this.buffer.push(item)
    if (this.buffer.length >= this.options.maxItems) {
      void this.flushNow()
      return
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => { void this.flushNow() }, this.options.flushIntervalMs)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.buffer.length > 0) await this.flushNow()
  }

  private async flushNow(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (this.buffer.length === 0) return
    const items = this.buffer
    this.buffer = []
    await this.options.flush(items)
  }
}
```

- [ ] **Step 4: 跑测试通过 + 提交**

```bash
pnpm --filter @tianji/controlplane test -- batch-committer.test.ts
git add apps/controlplane/src/storage/batch-committer.ts apps/controlplane/src/storage/__tests__/batch-committer.test.ts
git commit -m "feat(controlplane): 新增 BatchCommitter 支持 50ms/500 条批量策略"
```

---

### Task 4: SqliteEventLogStore（TDD）

**Files:**
- Create: `apps/controlplane/src/storage/event-log-sqlite.ts`
- Create: `apps/controlplane/src/storage/__tests__/event-log-sqlite.test.ts`

- [ ] **Step 1: 写失败测试**

参照仓内既有 `apps/controlplane/src/db/__tests__/*` 的测试搭建方式（读取 1-2 个作为模板），用 `better-sqlite3` 内存库 + 执行 `SCHEMA_SQL` 建表。关键用例：

```ts
// apps/controlplane/src/storage/__tests__/event-log-sqlite.test.ts
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { SCHEMA_SQL } from '../../db/schema.js'
import { SqliteEventLogStore } from '../event-log-sqlite.js'
import type { DomainEventEnvelope } from '@tianji/shared'

function freshDb() {
  const db = new Database(':memory:')
  db.exec(SCHEMA_SQL)
  return db
}

function env(seq: number, overrides: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope {
  return {
    eventId: `e${seq}`,
    type: 'RunStarted',
    occurredAt: `2026-04-14T00:00:${String(seq).padStart(2, '0')}Z`,
    correlationId: 'c1',
    causationId: null,
    sequence: seq,
    aggregateType: 'Run',
    aggregateId: 'r1',
    source: { processKind: 'node', processId: 'p1' },
    payload: { type: 'RunStarted' } as never,
    ...overrides,
  } as DomainEventEnvelope
}

describe('SqliteEventLogStore', () => {
  it('append 写入后 maxSequence 返回最大值', async () => {
    const store = new SqliteEventLogStore(freshDb())
    await store.append([env(1), env(2), env(3)])
    expect(await store.maxSequence('Run', 'r1')).toBe(3)
    expect(await store.maxSequence('Run', 'rX')).toBeNull()
  })

  it('UNIQUE(aggregate_type, aggregate_id, sequence) 冲突直接 throw', async () => {
    const store = new SqliteEventLogStore(freshDb())
    await store.append([env(1)])
    await expect(store.append([env(1, { eventId: 'e1b' })])).rejects.toThrow()
  })

  it('queryByAggregate 按 fromSequence 过滤', async () => {
    const store = new SqliteEventLogStore(freshDb())
    await store.append([env(1), env(2), env(3)])
    const out: number[] = []
    for await (const e of store.queryByAggregate('Run', 'r1', 2)) out.push(e.sequence)
    expect(out).toEqual([2, 3])
  })

  it('queryByCorrelation 跨聚合按 sequence 排序', async () => {
    const store = new SqliteEventLogStore(freshDb())
    await store.append([
      env(1, { aggregateId: 'r1', sequence: 1, correlationId: 'c1' }),
      env(1, { aggregateId: 'r2', sequence: 1, correlationId: 'c1', eventId: 'eX' }),
      env(2, { aggregateId: 'r1', sequence: 2, correlationId: 'c1', eventId: 'eY' }),
    ])
    const out: string[] = []
    for await (const e of store.queryByCorrelation('c1')) out.push(e.eventId)
    expect(out.length).toBe(3)
  })
})
```

- [ ] **Step 2: 跑失败**

```bash
pnpm --filter @tianji/controlplane test -- event-log-sqlite.test.ts
```

- [ ] **Step 3: 实现**

```ts
/**
 * event_log 的 better-sqlite3 实现。
 * 本实现 append 是同步的（transaction 包单次批），但返回 Promise 以贴合接口。
 * @module storage/event-log-sqlite
 */

import type Database from 'better-sqlite3'
import type {
  AggregateType,
  DomainEventEnvelope,
  EventLogAppendResult,
  EventLogStore,
} from '@tianji/shared'

interface Row {
  event_id: string
  type: string
  occurred_at: string
  correlation_id: string
  causation_id: string | null
  sequence: number
  aggregate_type: string
  aggregate_id: string
  source_json: string
  payload_json: string
}

function rowToEnvelope(row: Row): DomainEventEnvelope {
  return {
    eventId: row.event_id,
    type: row.type,
    occurredAt: row.occurred_at,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    sequence: row.sequence,
    aggregateType: row.aggregate_type as AggregateType,
    aggregateId: row.aggregate_id,
    source: JSON.parse(row.source_json),
    payload: JSON.parse(row.payload_json),
  } as DomainEventEnvelope
}

export class SqliteEventLogStore implements EventLogStore {
  private readonly insertStmt: Database.Statement
  private readonly maxStmt: Database.Statement
  private readonly byAggStmt: Database.Statement
  private readonly byCorrStmt: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO event_log
      (event_id, type, occurred_at, correlation_id, causation_id,
       sequence, aggregate_type, aggregate_id, source_json, payload_json)
      VALUES
      (@event_id, @type, @occurred_at, @correlation_id, @causation_id,
       @sequence, @aggregate_type, @aggregate_id, @source_json, @payload_json)
    `)
    this.maxStmt = db.prepare(`
      SELECT MAX(sequence) as max_seq FROM event_log
      WHERE aggregate_type = ? AND aggregate_id = ?
    `)
    this.byAggStmt = db.prepare(`
      SELECT * FROM event_log
      WHERE aggregate_type = ? AND aggregate_id = ? AND sequence >= ?
      ORDER BY sequence ASC
    `)
    this.byCorrStmt = db.prepare(`
      SELECT * FROM event_log
      WHERE correlation_id = ? AND sequence >= ?
      ORDER BY occurred_at ASC, sequence ASC
    `)
  }

  async append(events: readonly DomainEventEnvelope[]): Promise<EventLogAppendResult> {
    if (events.length === 0) return { written: 0 }
    const tx = this.db.transaction((items: readonly DomainEventEnvelope[]) => {
      for (const e of items) {
        this.insertStmt.run({
          event_id: e.eventId,
          type: e.type,
          occurred_at: e.occurredAt,
          correlation_id: e.correlationId,
          causation_id: e.causationId,
          sequence: e.sequence,
          aggregate_type: e.aggregateType,
          aggregate_id: e.aggregateId,
          source_json: JSON.stringify(e.source),
          payload_json: JSON.stringify(e.payload),
        })
      }
    })
    tx(events)
    return { written: events.length }
  }

  async maxSequence(
    aggregateType: AggregateType,
    aggregateId: string,
  ): Promise<number | null> {
    const row = this.maxStmt.get(aggregateType, aggregateId) as { max_seq: number | null } | undefined
    return row?.max_seq ?? null
  }

  async *queryByAggregate(
    aggregateType: AggregateType,
    aggregateId: string,
    fromSequence = 1,
  ): AsyncIterable<DomainEventEnvelope> {
    const rows = this.byAggStmt.all(aggregateType, aggregateId, fromSequence) as Row[]
    for (const row of rows) yield rowToEnvelope(row)
  }

  async *queryByCorrelation(
    correlationId: string,
    fromSequence = 1,
  ): AsyncIterable<DomainEventEnvelope> {
    const rows = this.byCorrStmt.all(correlationId, fromSequence) as Row[]
    for (const row of rows) yield rowToEnvelope(row)
  }
}
```

- [ ] **Step 4: 跑测试通过 + 提交**

```bash
pnpm --filter @tianji/controlplane test -- event-log-sqlite.test.ts
git add apps/controlplane/src/storage/event-log-sqlite.ts apps/controlplane/src/storage/__tests__/event-log-sqlite.test.ts
git commit -m "feat(controlplane): 实现 SqliteEventLogStore"
```

---

### Task 5: 从 EventLogStore 适配 SequenceRecoverer

**Files:**
- Create: `apps/controlplane/src/storage/event-log-recoverer.ts`

- [ ] **Step 1: 写文件**

```ts
/**
 * 从 EventLogStore 适配 SequenceRecoverer。
 * @module storage/event-log-recoverer
 */

import type { EventLogStore, AggregateType } from '@tianji/shared'
import type { SequenceRecoverer } from '@tianji/runtime'

export function createEventLogRecoverer(store: EventLogStore): SequenceRecoverer {
  return {
    async maxSequence(aggregateType: AggregateType, aggregateId: string) {
      return store.maxSequence(aggregateType, aggregateId)
    },
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/controlplane/src/storage/event-log-recoverer.ts
git commit -m "feat(controlplane): 适配 EventLogStore → SequenceRecoverer"
```

---

### Task 6: Bus 订阅者封装（EventLog 订阅者）

**Files:**
- Create: `apps/controlplane/src/storage/event-log-subscriber.ts`

- [ ] **Step 1: 写 event-log-subscriber.ts**

```ts
/**
 * Bus 订阅者：把 envelope 喂给 BatchCommitter，再落到 EventLogStore。
 * @module storage/event-log-subscriber
 */

import type { DomainEventEnvelope, EventBus, EventLogStore, SubscriptionHandle } from '@tianji/shared'
import { BatchCommitter } from './batch-committer.js'

export interface EventLogSubscriberOptions {
  readonly maxItems?: number
  readonly flushIntervalMs?: number
}

export function subscribeEventLog(
  bus: EventBus,
  store: EventLogStore,
  options: EventLogSubscriberOptions = {},
): { subscription: SubscriptionHandle; committer: BatchCommitter<DomainEventEnvelope> } {
  const committer = new BatchCommitter<DomainEventEnvelope>({
    maxItems: options.maxItems ?? 500,
    flushIntervalMs: options.flushIntervalMs ?? 50,
    flush: async (batch) => { await store.append(batch) },
  })
  const subscription = bus.subscribe(
    {},
    (env) => { committer.push(env) },
    { name: 'event-log-subscriber', queueSize: 10_000 },
  )
  return { subscription, committer }
}
```

- [ ] **Step 2: 提交**

```bash
git add apps/controlplane/src/storage/event-log-subscriber.ts
git commit -m "feat(controlplane): 新增 EventLog bus 订阅者批量写入"
```

---

### Task 7: 整仓 check

- [ ] **Step 1: 跑全量**

```bash
pnpm check
```
Expected: 全绿。修复所有 error / warning / info。

- [ ] **Step 2: 如有 staged 修复，创建 commit**

```bash
git commit -m "fix: 修复阶段 04 产生的 check 报错"
```

---

## Self-Review Checklist

- [ ] `event_log` 表 UNIQUE(aggregate_type, aggregate_id, sequence) 约束存在。
- [ ] `SqliteEventLogStore.append` 冲突 throw，**不做** upsert / ignore。
- [ ] `BatchCommitter.dispose` 清剩余 buffer。
- [ ] 所有 store 方法返回 Promise / AsyncIterable 匹配接口。
- [ ] `maxItems=500`、`flushIntervalMs=50` 与 spec §四.4 一致。
- [ ] 文件 < 800 行。
