# 事件总线与领域事件建模设计

> 日期：2026-04-14
> 范围：Core 领域事件 + Integration 信封与持久化 + Protocol 适配 + 进程内事件总线
> 基线：[2026-04-14-events-inventory.md](./2026-04-14-events-inventory.md)
> 状态：Design（待实现）

---

## 一、目标与非目标

### 目标

1. 把现状 7 层事件（RuntimeEvent / TaskEvent / ACP / AG-UI / Daemon SSE / OTel / 日志）**按领域聚合**重整为三层架构：Core（领域事件）/ Integration（跨进程信封与持久化）/ Protocol（对外协议适配）。
2. 补齐未建模的领域事件（Session / Node 生命周期、`TaskObservationLost`）。
3. 建立**跨聚合、跨进程的完整因果追踪与重放能力**（`correlationId + causationId + sequence` 三件套）。
4. 建立**进程内事件总线**，消除现状 5+ 处消费 / 5 层透传链带来的耦合。
5. 建立**跨进程事件信封**，替代当前仅服务于 Task 聚合的 `TaskEvent`。

### 非目标

1. **不做 Event Sourcing**：event_log 是事实日志不是状态源。当前业务状态仍在专用表里（Node 表、Task 表、Session checkpoint 等）。事件日志仅用于审计、重放、追踪。
2. **不做 at-least-once / exactly-once 投递保证**：遵循 "Let it crash"，消费者挂了就挂了；需要幂等的消费者自己处理。
3. **不做订阅者断线重连的事件补发**：重放只给审计/调试用，浏览器 SSE 断线由前端重建会话。
4. **不改变跨进程物理传输层**：HTTP NDJSON（node↔cp）/ stdio NDJSON（ACP）/ SSE（daemon↔cli）保留，只统一信封。
5. **不做快捷键 / 前端 CustomEvent 系统**：前端事件系统超出本 spec。

---

## 二、三层架构总览

```
┌─────────────────────────────────────────────────────────┐
│ Protocol 层（订阅者，向外部协议翻译）                    │
│   AG-UI Adapter / ACP Adapter / Daemon SSE Adapter       │
│   OTel Adapter / Observer Logger                         │
└───────────────────▲─────────────────────────────────────┘
                    │ subscribe(filter, handler)
┌───────────────────┴─────────────────────────────────────┐
│ Integration 层                                           │
│   ├─ EventBus（进程内，thin pub/sub）                    │
│   ├─ DomainEventEnvelope（统一信封）                     │
│   ├─ Cross-Process Forwarder（node→cp NDJSON）           │
│   └─ EventLogStore（批量提交到 SQLite event_log）        │
└───────────────────▲─────────────────────────────────────┘
                    │ emitEvent callback
┌───────────────────┴─────────────────────────────────────┐
│ Core 层（聚合根发射领域事件）                            │
│   Session / GraphRun / Run（+Message/Tool entity）       │
│   Task / Node                                            │
└─────────────────────────────────────────────────────────┘
```

---

## 三、Core 层：聚合与领域事件

### 3.1 聚合关系

| 聚合 | 类型 | 父子 / 关联 | Writer 进程 |
|------|------|-------------|-------------|
| **Session** | 聚合根 | 承载 checkpoint，跨多个 GraphRun | daemon（runtime 宿主） |
| **GraphRun** | 聚合根 | 由 Session 触发 | daemon / node（谁启动谁拥有） |
| **Run** | 聚合根 | GraphRun 的子聚合（通过 `graphRunId` 关联）；由 agent-kind 节点产生 | 同 GraphRun |
| **Message** | Run 内 entity（**非聚合根**） | 属于 Run | 同 Run |
| **Tool** | Run 内 entity（**非聚合根**） | 属于 Run | 同 Run |
| **Task** | 聚合根 | 跨进程包装 GraphRun | **node**（task-executor） |
| **Node** | 聚合根 | 物理 worker | cp（registry 观察者） |

### 3.2 聚合关系图

```
Session ──触发──▶ GraphRun ──node=agent─▶ Run
                    │                       ├─ Message（平行 entity）
                    │                       └─ Tool（平行 entity）
                    ▼
                  其他 node kinds（human-gate / fork / acp-agent）

Task ──包装──▶ GraphRun（跨进程）

Node（独立生命周期：注册 / 重注册 / 下线）
```

### 3.3 领域事件完整清单

所有事件名采用 **PascalCase**，TS 类型名与 envelope `type` 字段字符串一致。

| 聚合 | 事件 | 对应现状 | 备注 |
|------|------|----------|------|
| **Session** | `SessionCreated` | 新增 | |
| | `SessionResumed` | 新增 | checkpoint 恢复 |
| | `SessionClosed` | 新增 | |
| **GraphRun** | `GraphRunStarted` | `graph.started` | |
| | `GraphRunCompleted` | `graph.completed` | |
| | `GraphRunFailed` | **新增**（现状缺失） | |
| | `GraphNodeStarted` | `graph.node.started` | 保留 `nodeKind` 字段 |
| | `GraphNodeCompleted` | `graph.node.completed` | |
| | `GraphNodeFailed` | `graph.node.failed` | |
| **Run** | `RunStarted` | `run.started` | |
| | `RunCompleted` | `run.completed` | |
| | `RunFailed` | `run.failed` | |
| | `RunCancelled` | `run.cancelled` | HITL 合并到此，payload 带 `reason: 'hitl' \| 'abort'` |
| | `MessageStarted` | `message.started` | Run 内 entity 事件 |
| | `MessageDelta` | `message.delta` | 保留 text/thinking 双通道区分字段 |
| | `MessageCompleted` | `message.completed` | |
| | `ToolStarted` | `tool.started` | Run 内 entity 事件 |
| | `ToolCompleted` | `tool.completed` | |
| | `ToolFailed` | `tool.failed` | |
| **Task** | `TaskStarted` | `task.started` | |
| | `TaskWaiting` | `task.waiting` | HITL 挂起 |
| | `TaskSessionAttached` | `task.session.attached` | |
| | `TaskCompleted` | `task.completed` | |
| | `TaskFailed` | `task.failed` | |
| | `TaskCancelled` | `task.cancelled` | |
| | `TaskObservationLost` | **新增**（原仅日志） | **由 cp 发射**，语义 = "writer 失联"，消费者自行推断终态 |
| **Node** | `NodeRegistered` | **新增**（原仅日志） | |
| | `NodeReRegistered` | **新增**（原仅日志） | |
| | `NodeMarkedOffline` | **新增**（原仅日志） | |

### 3.4 显式不建模

| 原事件 | 不建模理由 |
|--------|------------|
| `RunHitlInterrupted` | 并入 `RunCancelled(reason='hitl')` |
| `CommandLeased` | DB 状态字段即可，不是领域事件 |
| `NodeHeartbeatReceived` | 30s 心跳是运维指标，走 metrics 不走 event bus |

---

## 四、Integration 层：信封、存储、总线

### 4.1 DomainEventEnvelope

所有事件出聚合边界时套统一信封：

```ts
type AggregateType = 'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node';

interface DomainEventEnvelope<T extends DomainEvent = DomainEvent> {
  // 身份
  eventId: string;            // ULID，事件自身唯一 ID
  type: T['type'];            // 'RunStarted' 等 PascalCase
  occurredAt: string;         // ISO8601
  // 因果链（三件套）
  correlationId: string;      // 一整条业务链共享
  causationId: string | null; // 直接触发本事件的上游 eventId
  sequence: number;           // 单聚合实例内递增（从 1 开始）
  // 聚合归属
  aggregateType: AggregateType;
  aggregateId: string;
  // 发射来源（用于 writer 归属校验）
  source: {
    processKind: 'daemon' | 'node' | 'cp';
    processId: string;        // 进程实例 ID
    nodeId?: string;          // processKind='node' 时必带
  };
  // 业务载荷
  payload: T;
}
```

### 4.2 单 writer 不变式（关键）

**每个聚合实例（aggregateId 粒度）在整个生命周期里只有一个 writer 进程。**

#### Writer 归属规则

| 聚合 | Writer | 约束 |
|------|--------|------|
| Session | 创建它的 daemon 进程 | Session 只在宿主 daemon 内活 |
| GraphRun | 启动它的进程（daemon 或 node） | graph-runner 只跑在一个进程 |
| Run / Message / Tool | 同 GraphRun 所在进程 | 子聚合 / 内部 entity |
| **Task** | **node（task-executor）** | UI "取消"**不得**由 cp 伪造 `TaskCancelled`，必须走 command poll → node → node 发 |
| **TaskObservationLost** | **cp**（例外：观察事件不是 Task 自己的终态） | cp 作为观察者发，不破坏 Task writer 不变式 |
| Node | cp（registry） | |

#### 三重防线

| 层 | 机制 | 失败行为 |
|----|------|----------|
| L1 发射方 | 进程内内存计数器 `Map<aggregateId, number>`；启动/接管聚合时查 `MAX(sequence)` 初始化 | 正常来源 |
| L2 存储层 | `event_log` 表 `UNIQUE(aggregate_type, aggregate_id, sequence)` 约束 | **INSERT 冲突 = crash**，不重试不重分配 |
| L3 ingest 端 | cp 校验 envelope `source` 与聚合 writer 归属规则一致 | 非法写入拒绝并 crash |


### 4.3 因果链规则

| 字段 | 分配方 | 规则 |
|------|--------|------|
| `correlationId` | 业务入口 | Task 创建、Session 创建、ACP session 入口分别生成一个；此后同一业务链所有事件共享 |
| `causationId` | 发射方 | runtime 维护"当前上下文 eventId"；事件发射时填入；根事件为 `null` |
| `sequence` | 发射方 | 聚合实例内计数器；从 1 开始 |

### 4.4 event_log 表结构

```sql
CREATE TABLE event_log (
  event_id       TEXT PRIMARY KEY,     -- ULID
  type           TEXT NOT NULL,        -- 'RunStarted' 等
  occurred_at    TEXT NOT NULL,        -- ISO8601
  correlation_id TEXT NOT NULL,
  causation_id   TEXT,
  sequence       INTEGER NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  source_json    TEXT NOT NULL,        -- source{}
  payload_json   TEXT NOT NULL,        -- payload{}
  UNIQUE(aggregate_type, aggregate_id, sequence)
);

CREATE INDEX idx_event_log_correlation ON event_log(correlation_id, sequence);
CREATE INDEX idx_event_log_aggregate ON event_log(aggregate_type, aggregate_id, sequence);
CREATE INDEX idx_event_log_occurred_at ON event_log(occurred_at);
```

**批量提交策略**：cp ingest 收到事件先进内存环形缓冲，**50ms 或 500 条**触发一次 batch INSERT。崩溃丢失窗口 ≤ 50ms，与"重放仅审计用"的非目标一致。

### 4.5 重启恢复

writer 进程启动 / 接管聚合时：

1. 查询所有**活跃聚合实例**（未发终态事件的）
2. 对每个活跃聚合 `SELECT MAX(sequence) FROM event_log WHERE aggregate_type=? AND aggregate_id=?`
3. 内存计数器初始化为 `MAX(sequence) + 1`（新聚合从 1 开始）

**活跃聚合判定**：

| 聚合 | 活跃条件 |
|------|----------|
| Session | 未发 `SessionClosed` |
| GraphRun | 未发 `GraphRunCompleted/Failed` |
| Run | 未发 `RunCompleted/Failed/Cancelled` |
| Task | 未发 `TaskCompleted/Failed/Cancelled`；cp 侧额外未发 `TaskObservationLost` |
| Node | 未发 `NodeMarkedOffline` |

### 4.6 进程内 EventBus

**实现**：自写薄 Bus（< 200 行），不用 EventEmitter 也不用 RxJS。

```ts
interface EventFilter {
  aggregateType?: AggregateType[];
  aggregateId?: string;
  correlationId?: string;
  type?: string[];
}

interface Subscription {
  unsubscribe(): void;
}

interface EventBus {
  publish(envelope: DomainEventEnvelope): void;
  subscribe(
    filter: EventFilter,
    handler: (env: DomainEventEnvelope) => void | Promise<void>,
    options?: { queueSize?: number; name: string },
  ): Subscription;
  replay(filter: EventFilter, fromSequence?: number): AsyncIterable<DomainEventEnvelope>;
}
```

#### 语义约束

| 项 | 规则 |
|----|------|
| `publish` 同步性 | **publish 函数同步返回**（只往订阅者队列塞）；不等订阅者 handler 执行完 |
| 订阅者异步化 | 每订阅者独立有界队列；`handler` 在 `queueMicrotask` 中顺序执行 |
| 慢订阅者 | 队列满时**丢弃事件并发射 `SubscriberLag`**（元事件，本身不入 event_log 避免循环） |
| 过滤 | 在 `publish` 时按 filter 匹配投递，不匹配的订阅者不进队列 |
| 重放 | 从 event_log 读；`fromSequence` 限定单聚合内起点；跨聚合重放按 `correlationId` 过滤 |

### 4.7 Runtime 接入方式

**保留现有 `emitEvent` 回调**，不让 runtime 直接持有 Bus 引用。

```ts
// runtime 仍然是纯函数风格
function runGraph(ctx, { emitEvent }: { emitEvent: (ev: DomainEvent) => void }) { ... }

// 装配层把 "publish 到 Bus" 作为 emitEvent 实现注入
const emitEvent = (ev: DomainEvent) => {
  const envelope = wrapEnvelope(ev, context);  // 填 eventId/sequence/correlationId/causationId/source
  bus.publish(envelope);
};
runGraph(ctx, { emitEvent });
```

**好处**：
- runtime 仍可单测（传 mock emitEvent）
- Bus 是装配层职责，不污染 Core

**`wrapEnvelope` 职责**：
- 查上下文拿 `correlationId` / `causationId`
- 找到聚合实例的计数器并 `++` 得到 `sequence`
- 生成 `eventId`（ULID）
- 填 `source` 字段

---

## 五、Protocol 层：5 个适配器

所有适配器都是 Bus 订阅者，输入统一为 `DomainEventEnvelope`。

| 适配器 | 位置 | 订阅过滤 | 输出 |
|--------|------|----------|------|
| **AG-UI Adapter** | `apps/controlplane/src/agents/event-mapper.ts` | 全聚合 | CopilotKit SSE（~15 种 BaseEvent）|
| **ACP Adapter（外 → 内）** | `packages/agent/src/acp/event-mapper.ts` | Run 聚合（message/tool） | ACP `SessionUpdate` |
| **ACP Adapter（内 → 外）** | `apps/node/src/acp/event-adapter.ts` | 同上 | 同上 |
| **Daemon SSE Adapter** | `packages/agent/src/daemon-protocol.ts` | GraphRun + Run + Message + Tool | `chat.event / chat.done / chat.error` |
| **OTel Adapter** | `packages/observer/src/tracing/` | `RunStarted/Completed/Failed` + `ToolStarted/Completed/Failed` | OTLP spans |
| **Observer Logger** | `packages/observer/src/` | 全聚合 | JSONL |

### 5.1 AG-UI / ACP 映射保持

现有 [盘点文档第五节](./2026-04-14-events-inventory.md) 表中的 RuntimeEvent → AG-UI 映射 **完整保留**。仅输入类型从裸 RuntimeEvent 改为 `DomainEventEnvelope`。

### 5.2 兼容性约束（来自盘点文档）

| 约束 | 响应 |
|------|------|
| AG-UI 协议兼容不可破坏 | 输出格式不变，仅输入接口变 |
| ACP 协议兼容不可破坏 | 同上 |
| 多进程现状 | 保留 HTTP NDJSON / stdio NDJSON / SSE 三条物理通道 |

---

## 六、跨进程传输

| 方向 | 通道 | 载荷 | 改动 |
|------|------|------|------|
| node → cp | HTTP NDJSON（沿用 `/api/tasks/:taskId/events` 端点，语义升级为"任意聚合事件流"） | `DomainEventEnvelope` stream | **改**：原 `TaskEvent` 完全替换 |
| cp → browser | CopilotKit SSE | Protocol 层输出 | 不变 |
| cp → cli | Daemon SSE | `DomainEventEnvelope` 包在 `chat.event` 内 | 改：内层从 RuntimeEvent 改为 envelope |
| ACP 双向 | stdio NDJSON | `DomainEventEnvelope` ↔ ACP `SessionUpdate` | 改：内层替换 |

### 6.1 TaskEvent 彻底废弃

| 项 | 处置 |
|----|------|
| 类型 `TaskEvent`（lifecycle + agent wrapper） | **删除** |
| 端点 `/api/tasks/:taskId/events` | **保留端点，语义升级**：接收 `DomainEventEnvelope` NDJSON 流（不再限定 Task 聚合） |
| SQLite `task_events` 表 | **废弃**，数据迁移到 `event_log` 一次性脚本 |
| `TaskLifecycleType` 枚举 | 删除，替换为 `TaskStarted/Waiting/...` 事件类型 |

---

## 七、包与模块位置

| 模块 | 位置 | 职责 |
|------|------|------|
| 事件类型 + envelope | `packages/shared/src/events/` | 纯类型定义；替换现 `events.ts` + `task-event.ts` |
| EventBus 实现 | `packages/shared/src/bus/` | 薄 pub/sub |
| `wrapEnvelope` / 计数器 | `packages/runtime/src/bus/` | 装配层，把 emitEvent 接到 Bus |
| `EventLogStore` 接口 | `packages/shared/src/storage/event-log.ts` | 存储抽象 |
| SQLite 实现 | `apps/controlplane/src/storage/event-log-sqlite.ts` | cp 侧实现 |
| Cross-process forwarder | `apps/node/src/bus/forwarder.ts` | 订阅 node 的 Bus，HTTP POST 到 cp |
| Cross-process ingest | `apps/controlplane/src/ingest/events.ts` | 接收 envelope 流，校验 writer 归属，写 event_log，publish 到 cp Bus |

---

## 八、迁移策略

**一次性切换，不做双写**。理由：
- 当前在研发状态，不需要考虑兼容性
- TaskEvent 已标记完全废弃
- 当前事件消费链都在自己仓库里，没有外部消费者
- 双写会引入两套计数器协调问题

**迁移步骤**（细节留给实现 plan）：

1. 新 `DomainEventEnvelope` 类型与 Core 事件定义落位
2. `EventBus` 实现 + 单测
3. `wrapEnvelope` + 计数器 + 重启恢复
4. event_log 表 + 迁移脚本（旧 task_events → event_log）
5. runtime / engine 的 `emitEvent` 接到 Bus
6. Protocol 适配器改造（AG-UI / ACP / Daemon SSE / OTel / Observer）
7. Cross-process forwarder + ingest（替换 TaskEvent 路径）
8. 删除 `task-event.ts` / `task_events` 表 / `TaskLifecycleType`

---

## 九、待用户确认的决策

无

## 十、未决问题

以下问题本 spec 未给答案，留给实现 plan 或后续 spec：

1. **correlationId 生成点**：Task 创建时一个 / Session 创建时一个 / ACP 入口一个；当一个 Task 触发一个 GraphRun 而 Task 本身又有 correlationId 时，两者关系是"Task 的 correlationId 直接沿用给内部 GraphRun/Run"。**需在实现 plan 中细化**跨入口汇聚场景。
2. **event_log 归档策略**：超过 N 天 / N GB 的事件怎么归档？本 spec 不覆盖，视为运维问题。
3. **`SubscriberLag` 元事件本身是否进 event_log**：本 spec 明确**不进**（避免循环），但需要另一条日志路径。实现 plan 中定。
4. **ACP acp-executor 模式下，外部 agent 的原始 sequence 是否保留**：本 spec 明确**不保留**（我们的 event_log 只记我们视角），外部 agent 自己的事件链是它的事。实现 plan 中若需要"穿透视图"再议。

---

## 十一、与现状的对照速查

| 现状 | 未来 |
|------|------|
| `RuntimeEvent`（15 种，命名 `run.started` 等） | Core 层 `DomainEvent` 联合（PascalCase），+ Session / Node 新增事件 |
| `TaskEvent`（NDJSON 跨进程） | `DomainEventEnvelope`（统一信封） |
| ACP `event-mapper.ts` | Protocol Adapter（订阅者） |
| AG-UI `event-mapper.ts` | Protocol Adapter（订阅者） |
| Daemon SSE `chat.event` | Protocol Adapter（订阅者） |
| `task_events` 表 | `event_log` 表（统一） |
| `emitEvent` 回调 | 保留，装配层把 publish 接上 |
| 5 层透传链 | Bus 发 → 所有订阅者并行消费 |
| `NodeRegistered / NodeMarkedOffline / TaskObservationLost` 仅日志 | 正式领域事件 |
| `RunHitlInterrupted` | 合并入 `RunCancelled(reason='hitl')` |
| sequence 仅 Task 聚合有 | 所有聚合都有 + UNIQUE 强制 + crash on conflict |
| 无 correlationId / causationId | 三件套齐全，支持因果重放 |
