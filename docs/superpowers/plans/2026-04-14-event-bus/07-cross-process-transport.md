# 阶段 07：跨进程 Forwarder 与 Ingest

> Spec：[../../specs/2026-04-14-event-bus-design.md](../../specs/2026-04-14-event-bus-design.md) §六、§四.2 L3
> 前置：阶段 02（Bus）、04（Store）、05（runtime 发 DomainEvent）、06（适配器）
> 交付物：
>   - `apps/node/src/bus/forwarder.ts`：订阅 node bus，HTTP NDJSON POST 到 cp。
>   - `apps/controlplane/src/ingest/events.ts`：接收 envelope 流，做 writer 归属校验，写 event_log，publish 到 cp bus。
>   - 端点 `POST /api/tasks/:taskId/events` 语义升级为"任意聚合事件流"（端点路径**保留**以兼容现有部署，但已不限 Task 聚合）。

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 打通跨进程事件流：node 侧产生的 envelope 上送到 cp 落盘 + 发到 cp bus（让 cp 侧 AG-UI 等订阅者看见）。落地三重防线的 L3（ingest 归属校验）。

**Architecture:**
- **Node Forwarder**：`bus.subscribe({}, handler, { name: 'cp-forwarder' })`。handler 把 envelope 推进一个轻量 HTTP NDJSON 输出器（keep-alive connection），面向 cp `POST /api/tasks/:taskId/events`（注：taskId 是**当前关联 Task 的 id**；端点保留，`:taskId` 用作路由占位但 ingest 不再强制校验 body 聚合 = Task）。
- **CP Ingest**：逐行解析 envelope → writer 归属校验（若不通过 crash）→ store.append（批量仍由阶段 04 的 BatchCommitter 接住，但此处 ingest 直接 publish 到 cp bus；cp bus 的 event-log-subscriber 负责落盘，保证"写入 = publish + store.append" 是**同一路径**，不做双写）。

**注意**：端点命名虽叫 `task-events`，但内部不再区分聚合。将来可能重命名为 `/api/events`，**本阶段不改**以降低变更面。

**Tech Stack:** 现有 `apps/controlplane/src/routes/task-events.ts`、`apps/node/src/task/task-executor.ts` 的 NDJSON 传输，改内层载荷。

---

## File Structure

- Create: `apps/node/src/bus/forwarder.ts`
- Create: `apps/node/src/bus/__tests__/forwarder.test.ts`
- Modify: `apps/controlplane/src/routes/task-events.ts`（body 解析改 envelope；调 ingest）
- Create: `apps/controlplane/src/ingest/events.ts`（归属校验 + publish）
- Create: `apps/controlplane/src/ingest/writer-rules.ts`（归属规则表）
- Create: `apps/controlplane/src/ingest/__tests__/writer-rules.test.ts`
- Create: `apps/controlplane/src/ingest/__tests__/events.test.ts`
- Modify: daemon / task-executor 启动装配（移除旧 TaskEvent 发送点，替换为 forwarder）

---

### Task 1: Writer 归属规则（TDD）

**Files:**
- Create: `apps/controlplane/src/ingest/writer-rules.ts`
- Create: `apps/controlplane/src/ingest/__tests__/writer-rules.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// apps/controlplane/src/ingest/__tests__/writer-rules.test.ts
import { describe, expect, it } from 'vitest'
import { validateWriter } from '../writer-rules.js'
import type { DomainEventEnvelope } from '@tianji/shared'

function env(overrides: Partial<DomainEventEnvelope>): DomainEventEnvelope {
  return {
    eventId: 'e1', type: 'RunStarted', occurredAt: 'T',
    correlationId: 'c1', causationId: null, sequence: 1,
    aggregateType: 'Run', aggregateId: 'r1',
    source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
    payload: {} as never,
    ...overrides,
  } as DomainEventEnvelope
}

describe('validateWriter', () => {
  it('Task 只能由 node 发', () => {
    expect(() => validateWriter(env({ aggregateType: 'Task', type: 'TaskStarted' }))).not.toThrow()
    expect(() => validateWriter(env({
      aggregateType: 'Task', type: 'TaskStarted',
      source: { processKind: 'cp', processId: 'cp1' },
    }))).toThrow(/writer/)
  })

  it('TaskObservationLost 例外：只能由 cp 发', () => {
    expect(() => validateWriter(env({
      aggregateType: 'Task', type: 'TaskObservationLost',
      source: { processKind: 'cp', processId: 'cp1' },
    }))).not.toThrow()
    expect(() => validateWriter(env({
      aggregateType: 'Task', type: 'TaskObservationLost',
      source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
    }))).toThrow()
  })

  it('Node 只能由 cp 发', () => {
    expect(() => validateWriter(env({
      aggregateType: 'Node', type: 'NodeRegistered',
      source: { processKind: 'cp', processId: 'cp1' },
    }))).not.toThrow()
    expect(() => validateWriter(env({
      aggregateType: 'Node', type: 'NodeRegistered',
      source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
    }))).toThrow()
  })

  it('Session 只能由 daemon 发', () => {
    expect(() => validateWriter(env({
      aggregateType: 'Session', type: 'SessionCreated',
      source: { processKind: 'daemon', processId: 'd1' },
    }))).not.toThrow()
    expect(() => validateWriter(env({
      aggregateType: 'Session', type: 'SessionCreated',
      source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
    }))).toThrow()
  })

  it('GraphRun / Run 允许 daemon 或 node', () => {
    expect(() => validateWriter(env({ aggregateType: 'Run', source: { processKind: 'daemon', processId: 'd' } }))).not.toThrow()
    expect(() => validateWriter(env({ aggregateType: 'Run', source: { processKind: 'node', processId: 'p', nodeId: 'n' } }))).not.toThrow()
    expect(() => validateWriter(env({ aggregateType: 'Run', source: { processKind: 'cp', processId: 'cp' } }))).toThrow()
  })
})
```

- [ ] **Step 2: 跑失败**

```bash
pnpm --filter @tianji/controlplane test -- writer-rules.test.ts
```

- [ ] **Step 3: 实现**

```ts
/**
 * 跨进程 ingest 的 writer 归属校验。不通过 → throw（L3 防线）。
 * @module ingest/writer-rules
 */

import type { DomainEventEnvelope, ProcessKind } from '@tianji/shared'

function ensure(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`writer-rules: ${msg}`)
}

export function validateWriter(env: DomainEventEnvelope): void {
  const kind: ProcessKind = env.source.processKind
  switch (env.aggregateType) {
    case 'Session':
      ensure(kind === 'daemon', `Session must be emitted by daemon, got ${kind}`)
      return
    case 'GraphRun':
    case 'Run':
      ensure(kind === 'daemon' || kind === 'node', `${env.aggregateType} must be emitted by daemon/node, got ${kind}`)
      return
    case 'Task':
      if (env.type === 'TaskObservationLost') {
        ensure(kind === 'cp', `TaskObservationLost must be emitted by cp, got ${kind}`)
      } else {
        ensure(kind === 'node', `Task ${env.type} must be emitted by node, got ${kind}`)
      }
      return
    case 'Node':
      ensure(kind === 'cp', `Node must be emitted by cp, got ${kind}`)
      return
  }
}
```

- [ ] **Step 4: 跑通 + 提交**

```bash
pnpm --filter @tianji/controlplane test -- writer-rules.test.ts
git add apps/controlplane/src/ingest/writer-rules.ts apps/controlplane/src/ingest/__tests__/writer-rules.test.ts
git commit -m "feat(controlplane): writer 归属校验 L3 防线"
```

---

### Task 2: Ingest 主逻辑（TDD）

**Files:**
- Create: `apps/controlplane/src/ingest/events.ts`
- Create: `apps/controlplane/src/ingest/__tests__/events.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// apps/controlplane/src/ingest/__tests__/events.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createEventIngest } from '../events.js'
import type { DomainEventEnvelope } from '@tianji/shared'

function env(overrides: Partial<DomainEventEnvelope>): DomainEventEnvelope {
  return {
    eventId: 'e1', type: 'RunStarted', occurredAt: 'T',
    correlationId: 'c1', causationId: null, sequence: 1,
    aggregateType: 'Run', aggregateId: 'r1',
    source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
    payload: {} as never,
    ...overrides,
  } as DomainEventEnvelope
}

describe('createEventIngest', () => {
  it('通过校验的事件 publish 到 cp bus', async () => {
    const publish = vi.fn()
    const ingest = createEventIngest({ publish })
    await ingest.ingest(env({}))
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'e1' }))
  })

  it('归属校验失败 throw（Let it crash）', async () => {
    const publish = vi.fn()
    const ingest = createEventIngest({ publish })
    await expect(
      ingest.ingest(env({ aggregateType: 'Node', source: { processKind: 'node', processId: 'p', nodeId: 'n' } })),
    ).rejects.toThrow()
    expect(publish).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑失败**

```bash
pnpm --filter @tianji/controlplane test -- ingest/__tests__/events.test.ts
```

- [ ] **Step 3: 实现**

```ts
/**
 * 跨进程 ingest：校验 + publish 到 cp bus。
 * 落盘由 cp bus 的 event-log-subscriber 接手，保持单一路径。
 * @module ingest/events
 */

import type { DomainEventEnvelope } from '@tianji/shared'
import { validateWriter } from './writer-rules.js'

export interface EventIngestDeps {
  readonly publish: (env: DomainEventEnvelope) => void
}

export interface EventIngest {
  ingest(env: DomainEventEnvelope): Promise<void>
}

export function createEventIngest(deps: EventIngestDeps): EventIngest {
  return {
    async ingest(env) {
      validateWriter(env)
      deps.publish(env)
    },
  }
}
```

- [ ] **Step 4: 跑通 + 提交**

```bash
pnpm --filter @tianji/controlplane test -- ingest/__tests__/events.test.ts
git add apps/controlplane/src/ingest/events.ts apps/controlplane/src/ingest/__tests__/events.test.ts
git commit -m "feat(controlplane): event ingest 主逻辑（校验 + publish）"
```

---

### Task 3: `/api/tasks/:taskId/events` 路由改为消费 envelope NDJSON

**Files:**
- Modify: `apps/controlplane/src/routes/task-events.ts`
- Modify: 对应 `__tests__`

- [ ] **Step 1: 读取 route 当前实现**

- [ ] **Step 2: 把 body 解析改成"逐行 JSON.parse 得 DomainEventEnvelope"**

```ts
import { createEventIngest } from '../ingest/events.js'

export function mountTaskEvents(app, deps) {
  app.post('/api/tasks/:taskId/events', async (req, reply) => {
    const ingest = createEventIngest({ publish: (env) => deps.bus.publish(env) })
    for await (const line of readNdjsonLines(req.raw)) {
      if (!line.trim()) continue
      const env = JSON.parse(line) as DomainEventEnvelope
      await ingest.ingest(env)
    }
    return reply.code(204).send()
  })
}
```

**重要**：校验失败 → throw；Fastify 会回 500，node 侧连接断开，触发 node 侧进程 crash 策略（Let it crash）。

- [ ] **Step 3: 改对应路由测试**

测试 payload 从 `TaskEvent[]` 换成 `DomainEventEnvelope[]`。

- [ ] **Step 4: 跑测试**

```bash
pnpm --filter @tianji/controlplane test -- task-events.test.ts
```

- [ ] **Step 5: 提交**

```bash
git add apps/controlplane/src/routes/task-events.ts apps/controlplane/src/routes/__tests__/task-events.test.ts
git commit -m "refactor(controlplane): task-events 路由切为消费 DomainEventEnvelope NDJSON"
```

---

### Task 4: Node 侧 Forwarder（TDD）

**Files:**
- Create: `apps/node/src/bus/forwarder.ts`
- Create: `apps/node/src/bus/__tests__/forwarder.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// apps/node/src/bus/__tests__/forwarder.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createEventBus } from '@tianji/shared'
import { createForwarder } from '../forwarder.js'

describe('Forwarder', () => {
  it('订阅 bus 并批量 POST 到 cp', async () => {
    const post = vi.fn().mockResolvedValue(undefined)
    const bus = createEventBus({ lagSink: vi.fn() })
    const fwd = createForwarder({ bus, post, maxItems: 2, flushIntervalMs: 1000, currentTaskId: 't1' })
    const envMk = (seq: number) => ({
      eventId: `e${seq}`, type: 'RunStarted', occurredAt: 'T',
      correlationId: 'c1', causationId: null, sequence: seq,
      aggregateType: 'Run' as const, aggregateId: 'r1',
      source: { processKind: 'node' as const, processId: 'p', nodeId: 'n' },
      payload: {} as never,
    })
    bus.publish(envMk(1))
    bus.publish(envMk(2))
    await new Promise((r) => queueMicrotask(r))
    await new Promise((r) => queueMicrotask(r))
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0].taskId).toBe('t1')
    expect(post.mock.calls[0][0].events).toHaveLength(2)
    await fwd.dispose()
  })
})
```

- [ ] **Step 2: 跑失败**

```bash
pnpm --filter @tianji/node test -- forwarder.test.ts
```

- [ ] **Step 3: 实现**

```ts
/**
 * 订阅 node bus，批量 POST envelope 到 cp。
 * currentTaskId：route 占位，实际 ingest 不校验此 id。
 * @module bus/forwarder
 */

import type { DomainEventEnvelope, EventBus, SubscriptionHandle } from '@tianji/shared'
import { BatchCommitter } from '../../../../apps/controlplane/src/storage/batch-committer.js'
// 注：batch-committer 将在阶段 04 放在 cp 目录下；若要在 node 复用，可将其提升到 @tianji/shared。
// 本 Task 第 4 步会迁移 batch-committer 到 @tianji/shared。

export interface ForwarderPost {
  (body: { taskId: string; events: readonly DomainEventEnvelope[] }): Promise<void>
}

export interface ForwarderDeps {
  readonly bus: EventBus
  readonly post: ForwarderPost
  readonly maxItems: number
  readonly flushIntervalMs: number
  readonly currentTaskId: string
}

export function createForwarder(deps: ForwarderDeps): {
  subscription: SubscriptionHandle
  dispose: () => Promise<void>
} {
  const committer = new BatchCommitter<DomainEventEnvelope>({
    maxItems: deps.maxItems,
    flushIntervalMs: deps.flushIntervalMs,
    flush: async (events) => { await deps.post({ taskId: deps.currentTaskId, events }) },
  })
  const subscription = deps.bus.subscribe(
    {},
    (env) => committer.push(env),
    { name: 'cp-forwarder', queueSize: 10_000 },
  )
  return {
    subscription,
    dispose: async () => {
      subscription.unsubscribe()
      await committer.dispose()
    },
  }
}
```

- [ ] **Step 4: 把 `BatchCommitter` 从 `apps/controlplane/src/storage/` 提升到 `packages/shared/src/util/batch-committer.ts`**

因 forwarder 与 event-log-subscriber 都要用。`pnpm --filter @tianji/shared` 加 re-export，然后 cp 侧和 node 侧都从 `@tianji/shared` import。完成后在 `packages/shared/src/index.ts` 导出。

- [ ] **Step 5: 修正 forwarder.ts 的 import 为 `@tianji/shared`**

- [ ] **Step 6: 跑测试**

```bash
pnpm --filter @tianji/node test -- forwarder.test.ts
pnpm --filter @tianji/controlplane test
```

- [ ] **Step 7: 提交**

```bash
git add packages/shared/src/util/batch-committer.ts packages/shared/src/index.ts
git add apps/controlplane/src/storage
git add apps/node/src/bus
git commit -m "feat(bus): 新增 cross-process forwarder 并共享 BatchCommitter"
```

---

### Task 5: node 装配：用 forwarder 替换旧 TaskEvent 发送路径

**Files:**
- Modify: `apps/node/src/task/task-executor.ts`
- Modify: `apps/node/src/daemon-entry.ts`（或 wiring 点）

- [ ] **Step 1: 读取 task-executor.ts 定位旧 TaskEvent 发送代码（:91 / :119 / :137 / :155）**

- [ ] **Step 2: 删除旧 "构造 TaskEvent → NDJSON POST" 逻辑**

改为：
- TaskStarted/TaskCompleted/TaskFailed/TaskCancelled/TaskWaiting/TaskSessionAttached 从这里直接 `pipeline.emitEvent({ type: 'TaskStarted', ... })`；
- 不再手动包装 agent wrapper（原 TaskEvent.kind === 'agent'），runtime 内部事件自动通过 bus 走 forwarder。

- [ ] **Step 3: 在 wiring 处装配 forwarder**

```ts
import { createForwarder } from './bus/forwarder.js'

const forwarder = createForwarder({
  bus,
  post: async ({ taskId, events }) => {
    await cpClient.post(`/api/tasks/${taskId}/events`, {
      body: events.map((e) => JSON.stringify(e)).join('\n'),
      headers: { 'content-type': 'application/x-ndjson' },
    })
  },
  maxItems: 500,
  flushIntervalMs: 50,
  currentTaskId,
})
```

- [ ] **Step 4: 跑 node 测试**

```bash
pnpm --filter @tianji/node test
SMOKE_E2E=1 pnpm --filter @tianji/node test:smoke
```

- [ ] **Step 5: 提交**

```bash
git add apps/node/src/task apps/node/src/daemon-entry.ts
git commit -m "refactor(node): task-executor 改用 forwarder，移除旧 TaskEvent NDJSON 路径"
```

---

### Task 6: 整仓 check

- [ ] **Step 1: `pnpm check`**

- [ ] **Step 2: 冒烟 + 单测全绿**

```bash
SMOKE_E2E=1 pnpm --filter @tianji/node test:smoke
pnpm -r test
```

- [ ] **Step 3: 若修复有改动 → commit**

```bash
git commit -m "fix: 阶段 07 check 修复"
```

---

## Self-Review Checklist

- [ ] `validateWriter` 覆盖 5 个聚合的所有规则（含 TaskObservationLost 例外）。
- [ ] ingest 失败直接 throw，**不**做降级。
- [ ] node forwarder 使用共享 BatchCommitter，50ms/500 条策略与 spec §四.4 一致。
- [ ] `/api/tasks/:taskId/events` 路径**保留**，内层载荷已切 envelope。
- [ ] 冒烟通过，说明 node→cp→cp bus→AG-UI 全链路可用。
- [ ] `pnpm check` 全绿。
