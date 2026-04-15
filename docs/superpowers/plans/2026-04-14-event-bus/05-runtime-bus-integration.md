# 阶段 05：Runtime 接入 Bus、补齐新增领域事件

> Spec：[../../specs/2026-04-14-event-bus-design.md](../../specs/2026-04-14-event-bus-design.md) §三、§四.5、§四.7
> 前置：阶段 02（EventBus）、03（wrapEnvelope）、04（EventLogStore）
> 交付物：
>   - runtime / engine 的 `emitEvent` 改为发射**新的 DomainEvent**（PascalCase）；外部通过装配把 `wrap + publish` 挂上。
>   - 补发 Session / GraphRun / Node 相关新增事件（发射点需遍历代码）。
>   - `RunHitlInterrupted` 并入 `RunCancelled(reason='hitl')`。
>   - daemon 启动路径装配 `EventBus + Store + Recoverer + Wrapper`。

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 让 Core 层只发纯 DomainEvent，Integration 层装配把它 publish 到 Bus，进而 (a) 写 event_log，(b) 分发到 Protocol 订阅者。保留 `emitEvent` 回调架构，但事件类型从旧 `RuntimeEvent` 切换到新 `DomainEvent`。

**Architecture:**
1. 升级 `emitEvent` 参数类型：`DomainEvent`（来自 `@tianji/shared`）。
2. 改造所有发射点把事件名由 `'run.started'` 等 dot-case 换成 `'RunStarted'` 等 PascalCase，对应 payload 字段对齐阶段 01 的接口。
3. 新增发射点：
   - Session 生命周期事件（runtime/session.ts or 新 session manager）
   - GraphRun 事件（原 `graph.started/completed` 重命名为 `GraphRunStarted/Completed`，**新增** `GraphRunFailed`）
   - Node 事件（cp 侧 register / re-register / offline）
   - `TaskObservationLost`（cp observation monitor）
4. 提供 runtime 装配入口 `createRuntimeEventPipeline(deps)` 返回 `emitEvent` 回调；其内部组合 `wrapEnvelope + bus.publish + CausalContext` 上下文切换。
5. 在 daemon 启动与 cp 启动代码里装配 Bus / Store / Pipeline。

**Tech Stack:** 现有 `packages/runtime` / `packages/agent` / `apps/node` / `apps/controlplane`。

---

## File Structure

- Modify: `packages/runtime/src/runtime.ts`（所有 `emitEvent` 调用切新类型；保留函数签名语义）
- Modify: `packages/runtime/src/engines/deepagents-engine.ts`（同上）
- Modify: `packages/agent/src/orchestration/graph-runner.ts`（`graph.started/completed` → `GraphRunStarted/Completed`，新增 `GraphRunFailed` 发射）
- Modify: `packages/agent/src/orchestration/executors/deepagents-executor.ts`（`graph.node.*` → `GraphNode*`）
- Modify: `packages/agent/src/orchestration/executors/acp-executor.ts`（同上）
- Modify: `packages/agent/src/session.ts`（发 `SessionCreated/Resumed/Closed`）
- Modify: `apps/controlplane/src/routes/node-register.ts`（发 `NodeRegistered` / `NodeReRegistered`）
- Modify: `apps/controlplane/src/services/observation-monitor.ts`（发 `TaskObservationLost`；offline 触发 `NodeMarkedOffline`）
- Create: `packages/runtime/src/bus/pipeline.ts`（装配工厂）
- Create: `packages/runtime/src/bus/__tests__/pipeline.test.ts`
- Modify: `apps/node/src/daemon-entry.ts` / 其他 wiring 点（装配 Bus + Pipeline）
- Modify: `apps/controlplane/src/server.ts` / wiring 点（装配 Bus + Pipeline + EventLog 订阅）
- Create: `docs/runtime-event-mapping.md`（旧 → 新事件名映射速查，帮助阶段 06 改适配器）

---

### Task 1: 旧 → 新事件名映射速查（非代码变更）

**Files:**
- Create: `docs/runtime-event-mapping.md`

- [ ] **Step 1: 写映射表**

```markdown
# 旧 RuntimeEvent → 新 DomainEvent 映射

| 旧 (events.ts) | 新 (events/*) | payload 字段差异 |
|---------------|---------------|------------------|
| run.started | RunStarted | 无 |
| run.completed | RunCompleted | 无 |
| run.failed | RunFailed | 无 |
| run.cancelled | RunCancelled | 新增 `reason: 'hitl'\|'abort'` |
| message.started | MessageStarted | 无 |
| message.delta | MessageDelta | 无（`sequence` 字段仍为 Message 内片段序号，**不是** envelope.sequence） |
| message.completed | MessageCompleted | 无 |
| tool.started | ToolStarted | 无 |
| tool.completed | ToolCompleted | 无 |
| tool.failed | ToolFailed | 无 |
| graph.started | GraphRunStarted | 字段保持 `runId/graphId/graphVersion` |
| graph.completed | GraphRunCompleted | 同 |
| graph.node.started | GraphNodeStarted | 同 |
| graph.node.completed | GraphNodeCompleted | 同 |
| graph.node.failed | GraphNodeFailed | 同 |
| —（原仅日志） | GraphRunFailed | 新增 |
| task.* | Task*（Started/Waiting/SessionAttached/Completed/Failed/Cancelled） | 按 spec 重命名 |
| —（原仅日志） | TaskObservationLost | cp 发射 |
| —（原仅日志） | SessionCreated/Resumed/Closed | 新增 |
| —（原仅日志） | NodeRegistered/ReRegistered/MarkedOffline | cp 发射 |
| RunHitlInterrupted | RunCancelled(reason='hitl') | 合并，payload 新增 reason |
```

- [ ] **Step 2: 提交**

```bash
git add docs/runtime-event-mapping.md
git commit -m "docs: 旧 RuntimeEvent 与新 DomainEvent 映射速查"
```

---

### Task 2: `runtime.ts` 发射点改写（runtime.ts:552/649/707/745/781）

**Files:**
- Modify: `packages/runtime/src/runtime.ts`

- [ ] **Step 1: 读取 runtime.ts 完整（重要，在编辑前必读）**

```bash
# Read /workspaces/dev_docker/tianji-ai/packages/runtime/src/runtime.ts
```

- [ ] **Step 2: `emitEvent` 参数类型更新**

把 `emitEvent: (ev: RuntimeEvent) => void` 改为 `emitEvent: (ev: DomainEvent) => void | Promise<void>`。若现有上游仍传 `RuntimeEvent`，编译会断 — 顺藤摸到上游一层调用点同步改（在本 Task 范围内只改 runtime.ts，下个 Task 处理 engine，再下个 Task 处理 agent 层）。

- [ ] **Step 3: 发射点字符串替换**

| 行号 | 旧 | 新 |
|------|----|----|
| 552 | `type: 'run.started'` | `type: 'RunStarted'` |
| 649 | `type: 'run.cancelled'` | `type: 'RunCancelled', reason: 'hitl'`（原 HITL 分支） |
| 707 | `type: 'run.completed'` | `type: 'RunCompleted'` |
| 745 | `type: 'run.cancelled'` | `type: 'RunCancelled', reason: 'abort'`（原 abort 分支） |
| 781 | `type: 'run.failed'` | `type: 'RunFailed'` |

**重要**：行号来自盘点文档，实际可能有漂移。用 Grep 工具搜 `'run.started'` / `'run.cancelled'` 等定位。

- [ ] **Step 4: 跑 runtime 单测**

```bash
pnpm --filter @tianji/runtime test
```
Expected: 现有单测若硬编码旧字符串会挂 — 逐一把测试里的 `'run.started'` 等也改成 `'RunStarted'`。**不允许**为了绕过硬编码旧名保留 dot-case。

- [ ] **Step 5: 提交**

```bash
git add packages/runtime/src/runtime.ts packages/runtime/src/__tests__
git commit -m "refactor(runtime): runtime.ts 发射点切换为 PascalCase DomainEvent"
```

---

### Task 3: `deepagents-engine.ts` 发射点改写（148/162/293/336/423/498/669/722/770）

**Files:**
- Modify: `packages/runtime/src/engines/deepagents-engine.ts`

- [ ] **Step 1: 同 Task 2 的读取→Grep→字符串替换模式**

| 旧 | 新 |
|----|----|
| `'message.started'` | `'MessageStarted'` |
| `'message.delta'` | `'MessageDelta'` |
| `'message.completed'` | `'MessageCompleted'` |
| `'tool.started'` | `'ToolStarted'` |
| `'tool.completed'` | `'ToolCompleted'` |
| `'tool.failed'` | `'ToolFailed'` |

- [ ] **Step 2: 跑包级测试 → 修复同名测试**

```bash
pnpm --filter @tianji/runtime test
```

- [ ] **Step 3: 提交**

```bash
git add packages/runtime/src/engines/deepagents-engine.ts packages/runtime/src/engines/__tests__ packages/runtime/src/__tests__
git commit -m "refactor(runtime): deepagents-engine 切换为 PascalCase DomainEvent"
```

---

### Task 4: `graph-runner.ts` / executors 改写 + 新增 `GraphRunFailed`

**Files:**
- Modify: `packages/agent/src/orchestration/graph-runner.ts`
- Modify: `packages/agent/src/orchestration/executors/deepagents-executor.ts`
- Modify: `packages/agent/src/orchestration/executors/acp-executor.ts`

- [ ] **Step 1: 读取三个文件**

- [ ] **Step 2: 替换事件名**

| 旧 | 新 |
|----|----|
| `'graph.started'` | `'GraphRunStarted'` |
| `'graph.completed'` | `'GraphRunCompleted'` |
| `'graph.node.started'` | `'GraphNodeStarted'` |
| `'graph.node.completed'` | `'GraphNodeCompleted'` |
| `'graph.node.failed'` | `'GraphNodeFailed'` |

- [ ] **Step 3: 在 graph-runner.ts 的 catch 块（原仅 log）里新增发射 `GraphRunFailed`**

```ts
try {
  // 运行逻辑
} catch (error) {
  emitEvent({
    type: 'GraphRunFailed',
    runId,
    graphId,
    graphVersion,
    error: toTianjiError(error),
    timestamp: Date.now(),
  })
  throw error
}
```

**注意**：`toTianjiError` 已在 `@tianji/shared/errors` 中；若没有，直接构造符合 `TianjiError` 的对象。

- [ ] **Step 4: 跑 agent 包测试**

```bash
pnpm --filter @tianji/agent test
```

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/orchestration
git commit -m "refactor(agent): graph 事件切换为 GraphRun/GraphNode 并补发 GraphRunFailed"
```

---

### Task 5: Session 生命周期事件（`SessionCreated/Resumed/Closed`）

**Files:**
- Modify: `packages/agent/src/session.ts`

- [ ] **Step 1: 读取 session.ts 摸清目前有没有统一的创建/恢复/关闭出口**

- [ ] **Step 2: 在 Session 创建、从 checkpoint 恢复、关闭三个出口调 `emitEvent`**

若当前接口没有 `emitEvent`，在 `Session` 构造函数 / 工厂里接一个 `emitEvent` 可选依赖；调用方（agent-package wiring 处）注入。

示例（创建出口）：

```ts
emitEvent?.({
  type: 'SessionCreated',
  sessionId: session.id,
  timestamp: Date.now(),
})
```

resume：

```ts
emitEvent?.({
  type: 'SessionResumed',
  sessionId: session.id,
  checkpointId,
  timestamp: Date.now(),
})
```

close：

```ts
emitEvent?.({
  type: 'SessionClosed',
  sessionId: session.id,
  timestamp: Date.now(),
})
```

- [ ] **Step 3: 跑测试**

```bash
pnpm --filter @tianji/agent test
```

- [ ] **Step 4: 提交**

```bash
git add packages/agent/src/session.ts packages/agent/src/__tests__
git commit -m "feat(agent): Session 生命周期发射 SessionCreated/Resumed/Closed"
```

---

### Task 6: Node 事件（cp 侧 register / re-register / offline）

**Files:**
- Modify: `apps/controlplane/src/routes/node-register.ts`
- Modify: `apps/controlplane/src/services/observation-monitor.ts`（offline 发射点）

- [ ] **Step 1: 读取两文件**

- [ ] **Step 2: 在 register 路由成功分支发 `NodeRegistered`；在重复 register 路径发 `NodeReRegistered`**

```ts
emitEvent({
  type: 'NodeRegistered',
  nodeId,
  version,
  timestamp: Date.now(),
})
```

- [ ] **Step 3: 在 observation-monitor 把 node 置 offline 的路径发 `NodeMarkedOffline`**

```ts
emitEvent({
  type: 'NodeMarkedOffline',
  nodeId,
  reason: 'heartbeat-timeout',
  timestamp: Date.now(),
})
```

- [ ] **Step 4: 跑 cp 测试**

```bash
pnpm --filter @tianji/controlplane test
```

- [ ] **Step 5: 提交**

```bash
git add apps/controlplane/src/routes/node-register.ts apps/controlplane/src/services/observation-monitor.ts apps/controlplane/src/__tests__
git commit -m "feat(controlplane): Node 生命周期事件正式化"
```

---

### Task 7: `TaskObservationLost`（cp 作为观察者发射）

**Files:**
- Modify: `apps/controlplane/src/services/observation-monitor.ts`

- [ ] **Step 1: 读取该文件，定位 "writer 失联" 判定分支**

- [ ] **Step 2: 在此分支发射 `TaskObservationLost`**

```ts
emitEvent({
  type: 'TaskObservationLost',
  taskId,
  lastObservedAt: lastSeen.toISOString(),
  timestamp: Date.now(),
})
```

**约束**：cp 是此事件的 writer（spec §四.2 例外条款）。envelope.source.processKind 填 `'cp'`。

- [ ] **Step 3: 跑 cp 测试 + 提交**

```bash
pnpm --filter @tianji/controlplane test
git add apps/controlplane/src/services/observation-monitor.ts apps/controlplane/src/__tests__
git commit -m "feat(controlplane): 发射 TaskObservationLost 观察事件"
```

---

### Task 8: Runtime Pipeline 装配工厂（TDD）

**Files:**
- Create: `packages/runtime/src/bus/pipeline.ts`
- Create: `packages/runtime/src/bus/__tests__/pipeline.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// packages/runtime/src/bus/__tests__/pipeline.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeEventPipeline } from '../pipeline.js'
import { CausalContext } from '../causal-context.js'
import { SequenceCounter } from '../sequence-counter.js'
import { NoopSequenceRecoverer } from '../sequence-recoverer.js'

describe('createRuntimeEventPipeline', () => {
  it('emitEvent 包 envelope 后调用 publish；同步返回', async () => {
    const publish = vi.fn()
    const pipeline = createRuntimeEventPipeline({
      publish,
      counter: new SequenceCounter(),
      contextRef: { current: CausalContext.root('c1') },
      source: { processKind: 'daemon', processId: 'p1' },
      recoverer: NoopSequenceRecoverer,
    })
    await pipeline.emitEvent({
      type: 'RunStarted',
      runId: 'r1', sessionId: 's1', triggerType: 'fresh', timestamp: 0,
    } as never)
    expect(publish).toHaveBeenCalledTimes(1)
    const env = publish.mock.calls[0][0]
    expect(env.type).toBe('RunStarted')
    expect(env.sequence).toBe(1)
  })

  it('emitEvent 后更新 contextRef.current 为本事件的 child（因果链继承）', async () => {
    const publish = vi.fn()
    const contextRef = { current: CausalContext.root('c1') }
    const pipeline = createRuntimeEventPipeline({
      publish,
      counter: new SequenceCounter(),
      contextRef,
      source: { processKind: 'daemon', processId: 'p1' },
      recoverer: NoopSequenceRecoverer,
    })
    await pipeline.emitEvent({ type: 'RunStarted', runId: 'r1', sessionId: 's1', triggerType: 'fresh', timestamp: 0 } as never)
    const publishedId = (publish.mock.calls[0][0] as { eventId: string }).eventId
    expect(contextRef.current.causationId).toBe(publishedId)
  })
})
```

- [ ] **Step 2: 实现**

```ts
/**
 * Runtime 事件流水线：wrap envelope → publish → 因果链更新。
 * @module bus/pipeline
 */

import type { DomainEvent, DomainEventEnvelope, EnvelopeSource } from '@tianji/shared'
import type { CausalContextRef } from './envelope-wrapper.js'
import { createEnvelopeWrapper } from './envelope-wrapper.js'
import type { SequenceCounter } from './sequence-counter.js'
import type { SequenceRecoverer } from './sequence-recoverer.js'

export interface RuntimeEventPipelineDeps {
  readonly publish: (env: DomainEventEnvelope) => void
  readonly counter: SequenceCounter
  readonly contextRef: CausalContextRef
  readonly source: EnvelopeSource
  readonly recoverer: SequenceRecoverer
  readonly now?: () => string
}

export interface RuntimeEventPipeline {
  emitEvent(event: DomainEvent): Promise<void>
}

export function createRuntimeEventPipeline(
  deps: RuntimeEventPipelineDeps,
): RuntimeEventPipeline {
  const wrap = createEnvelopeWrapper({
    counter: deps.counter,
    context: deps.contextRef,
    source: deps.source,
    recoverer: deps.recoverer,
    now: deps.now,
  })
  return {
    async emitEvent(event) {
      const env = await wrap(event)
      deps.publish(env)
      deps.contextRef.current = deps.contextRef.current.child(env.eventId)
    },
  }
}
```

- [ ] **Step 3: 跑测试通过 + 提交**

```bash
pnpm --filter @tianji/runtime test -- pipeline.test.ts
git add packages/runtime/src/bus/pipeline.ts packages/runtime/src/bus/__tests__/pipeline.test.ts
git commit -m "feat(runtime): 新增 RuntimeEventPipeline 装配工厂"
```

---

### Task 9: daemon / cp 启动路径装配 Bus + Pipeline

**Files:**
- Modify: `apps/node/src/daemon-entry.ts`（以及 `task-executor` / `daemon-server` 等发射点 wiring 上游）
- Modify: `apps/controlplane/src/server.ts`（或 cp 的启动 wiring 文件）

- [ ] **Step 1: 识别 node 进程的装配点**

```bash
# Grep 'emitEvent' 定位当前 wiring 点
```

- [ ] **Step 2: 在 node 启动 wiring 处：**

```ts
import { createEventBus } from '@tianji/shared'
import { createRuntimeEventPipeline, SequenceCounter, CausalContext, NoopSequenceRecoverer } from '@tianji/runtime'

const bus = createEventBus({ lagSink: (info) => logger.warn({ info }, 'subscriber lag') })
const counter = new SequenceCounter()
const contextRef = { current: CausalContext.root(correlationId) }
const pipeline = createRuntimeEventPipeline({
  publish: (env) => bus.publish(env),
  counter,
  contextRef,
  source: { processKind: 'node', processId, nodeId },
  recoverer: NoopSequenceRecoverer, // node 侧不直连 event_log；阶段 07 后 forwarder 直接订阅 bus
})
// 把 pipeline.emitEvent 注入给 session/runGraph
```

- [ ] **Step 3: cp 启动 wiring 处：**

```ts
import { SqliteEventLogStore } from './storage/event-log-sqlite.js'
import { createEventLogRecoverer } from './storage/event-log-recoverer.js'
import { subscribeEventLog } from './storage/event-log-subscriber.js'

const store = new SqliteEventLogStore(db)
const recoverer = createEventLogRecoverer(store)
const bus = createEventBus({ lagSink: (info) => logger.warn({ info }, 'cp subscriber lag') })
const counter = new SequenceCounter()
const contextRef = { current: CausalContext.root(correlationId) }
const pipeline = createRuntimeEventPipeline({
  publish: (env) => bus.publish(env),
  counter, contextRef,
  source: { processKind: 'cp', processId },
  recoverer,
})
subscribeEventLog(bus, store)
```

- [ ] **Step 4: 把 Node 路由 / observation-monitor 发射点改为调用 pipeline.emitEvent**

即：Task 6 / Task 7 的 `emitEvent` 拿到的是 cp pipeline 的实现。

- [ ] **Step 5: 跑冒烟测试**

```bash
SMOKE_E2E=1 pnpm --filter @tianji/node test:smoke
```

Expected：现有冒烟应保持通过；若因事件名改动断，修测试期望。

- [ ] **Step 6: 提交**

```bash
git add apps/node apps/controlplane
git commit -m "feat(wiring): daemon 与 cp 启动路径装配 EventBus 与 Pipeline"
```

---

### Task 10: 整仓 check

- [ ] **Step 1: 跑 check**

```bash
pnpm check
```

- [ ] **Step 2: 若仍有 `RuntimeEvent` 残留引用，扫描并 union 到 `DomainEvent` 使用**

```bash
# Grep 'RuntimeEvent' packages/ apps/
```

剩余占位可能在：
- `packages/runtime/src/event-stream.ts`（若它还在用 RuntimeEvent）——暂保留，阶段 06 再改订阅方
- `packages/shared/src/events.ts` 旧文件——阶段 08 删

**本阶段原则**：runtime 与 agent 内部发射全部切新名；跨进程 TaskEvent wrapper 与 protocol 适配器**不在本阶段动**，由阶段 06 / 07 处理。

- [ ] **Step 3: 提交修复**

```bash
git commit -m "chore: 清理 RuntimeEvent 残留引用"
```

---

## Self-Review Checklist

- [ ] 所有 runtime / engine / graph-runner / executors 内部发射全部 PascalCase。
- [ ] `RunCancelled` 带 `reason` 字段。
- [ ] 新增 `GraphRunFailed` 在 graph-runner catch 分支发射。
- [ ] Session / Node / TaskObservationLost 发射点已补。
- [ ] pipeline.emitEvent 更新 contextRef.current，因果链可传导到子事件。
- [ ] daemon / cp 两处装配点都注入了正确 `source.processKind`。
- [ ] 单元测试与冒烟测试通过。
- [ ] `pnpm check` 全绿。
