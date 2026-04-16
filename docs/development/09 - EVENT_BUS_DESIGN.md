# Tianji AI 领域事件总线设计文档

> 状态：当前
> 日期：2026-04-15
> 相关文档：[`01 - ARCHITECTURE.md`](./01%20-%20ARCHITECTURE.md)、[`03 - RUNTIME_DESIGN.md`](./03%20-%20RUNTIME_DESIGN.md)、[`04 - OBSERVER_DESIGN.md`](./04%20-%20OBSERVER_DESIGN.md)
> 范围：领域事件建模、统一事件信封、进程内事件总线、跨进程转发、事件日志落盘、协议适配

---

## 1. 定位与目标

Tianji AI 现在把运行时里的关键业务变化统一建模为领域事件，再通过一条进程内事件总线向日志、协议适配器、持久化和跨进程转发分发。

这套设计要解决的是同一个老问题：过去运行时、任务、协议、日志各自维护一套事件形态，调用链很长，耦合很重。现在统一成一条主路径：

```text
业务代码发射 DomainEvent
  -> 包装成 DomainEventEnvelope
  -> publish 到 EventBus
  -> 由订阅者各自消费
```

这篇文档不是实施计划，也不是变更记录，而是解释当前系统里这条事件总线是什么、边界在哪、事件怎么流动。

### 1.1 设计目标

| 目标 | 说明 |
|------|------|
| 统一事件语义 | 用领域事件表达业务变化，而不是协议事件或日志事件 |
| 统一传输载荷 | 跨聚合、跨进程都使用 `DomainEventEnvelope` |
| 解耦生产者和消费者 | 业务代码只负责发事件，不直接调用 AG-UI、日志或落盘逻辑 |
| 可追踪 | 每个事件带 `correlationId`、`causationId`、`sequence` |
| 可审计 | controlplane 侧可把事件批量写入 `event_log` |

### 1.2 明确不做的事

| 不做什么 | 原因 |
|----------|------|
| 不做 Event Sourcing | 业务状态仍然以快照和专用表为准，事件日志不是状态源 |
| 不做 exactly-once / at-least-once | 系统遵循 Let it crash，失败直接暴露 |
| 不做订阅者断线补发 | 总线是当前事件分发通道，不是消息队列 |
| 不把协议事件当领域事件 | AG-UI、SSE、OTel 都是订阅者视角，不是领域模型本身 |

---

## 2. 三层结构

领域事件总线分三层看最清楚。

```text
Core
  领域事件本身：Session / GraphRun / Run / Task / Node

Integration
  DomainEventEnvelope / EventBus / sequence / 因果链 / event_log / forwarder / ingest

Protocol
  AG-UI adapter / Observer logger / OTel adapter / 其他外部协议映射
```

### 2.1 Core 层

Core 层只表达业务上发生了什么，不关心怎么传输、怎么持久化、怎么展示。

当前公共事件联合类型定义在 `packages/shared/src/events/domain-event.ts`，统一导出在 `packages/shared/src/events/index.ts`。

事件按聚合拆开维护：

| 聚合 | 文件 |
|------|------|
| Session | `packages/shared/src/events/session.ts` |
| GraphRun | `packages/shared/src/events/graph-run.ts` |
| Run | `packages/shared/src/events/run.ts` |
| Task | `packages/shared/src/events/task.ts` |
| Node | `packages/shared/src/events/node.ts` |

### 2.2 Integration 层

Integration 层负责把裸领域事件变成系统里真正流动的事件对象，并提供发布、转发、恢复和落盘能力。

关键部件：

| 部件 | 作用 | 位置 |
|------|------|------|
| `DomainEventEnvelope` | 统一事件信封 | `packages/shared/src/events/envelope.ts` |
| `EventBus` | 进程内薄 pub/sub 总线 | `packages/shared/src/bus/` |
| `createRuntimeEventPipeline` | runtime 发事件主入口 | `packages/runtime/src/bus/pipeline.ts` |
| `createEnvelopeWrapper` | 包装 eventId、sequence、因果链 | `packages/runtime/src/bus/envelope-wrapper.ts` |
| `SequenceCounter` | 聚合内单调序号计数器 | `packages/runtime/src/bus/sequence-counter.ts` |
| node forwarder | node/daemon 向 cp 批量转发 envelope | `apps/node/src/bus/forwarder.ts` |
| cp ingest | 校验 writer 后 publish 到 cp bus | `apps/controlplane/src/ingest/events.ts` |
| `SqliteEventLogStore` | 事件日志落盘 | `apps/controlplane/src/storage/event-log-sqlite.ts` |

### 2.3 Protocol 层

Protocol 层不生产领域事件，只订阅总线，然后把领域事件翻译成对外可消费的形式。

当前已明确的适配器包括：

| 适配器 | 作用 | 位置 |
|--------|------|------|
| AG-UI event mapper | 把 envelope 转成 AG-UI `BaseEvent[]` | `apps/controlplane/src/agents/event-mapper.ts` |
| EventBus logger adapter | 把 envelope 写入 observer trace 日志 | `packages/observer/src/logger/event-bus-adapter.ts` |
| event-log subscriber | 把 envelope 批量写入 `event_log` | `apps/controlplane/src/storage/event-log-subscriber.ts` |

---

## 3. 核心类型

### 3.1 DomainEvent

`DomainEvent` 是所有领域事件的联合类型：

```ts
export type DomainEvent =
  | SessionDomainEvent
  | GraphRunDomainEvent
  | RunDomainEvent
  | TaskDomainEvent
  | NodeDomainEvent
```

它只描述业务含义，比如：

- `RunStarted`
- `MessageDelta`
- `ToolCompleted`
- `TaskFailed`
- `NodeMarkedOffline`

业务代码发射的是这个层级的对象，不是 AG-UI 事件，也不是数据库行。

### 3.2 DomainEventEnvelope

一旦事件要离开聚合边界，系统就会给它套上统一信封：

```ts
interface DomainEventEnvelope<T extends DomainEvent = DomainEvent> {
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

字段作用如下：

| 字段 | 含义 |
|------|------|
| `eventId` | 事件唯一 ID，当前由 `ulid()` 生成 |
| `type` | 事件类型字符串，如 `RunStarted` |
| `occurredAt` | 事件发生时间 |
| `correlationId` | 同一条业务链共享的关联 ID |
| `causationId` | 直接触发当前事件的上游事件 ID |
| `sequence` | 同一个聚合实例内严格递增的序号 |
| `aggregateType` / `aggregateId` | 事件属于哪个聚合实例 |
| `source` | 由哪个进程发出，区分 `daemon` / `node` / `cp` |
| `payload` | 原始 `DomainEvent` |

### 3.3 EventBus

`EventBus` 是一条非常薄的进程内 pub/sub 总线，定义在 `packages/shared/src/bus/types.ts`：

```ts
interface EventBus {
  publish(env: DomainEventEnvelope): void
  subscribe(
    filter: EventFilter,
    handler: EventHandler,
    options: SubscribeOptions
  ): SubscriptionHandle
  close(): Promise<void>
}
```

它有几个关键约束：

| 约束 | 说明 |
|------|------|
| `publish` 同步返回 | 发布方不等待订阅者执行完成 |
| 每个订阅者独立队列 | 慢订阅者不会阻塞其他订阅者 |
| 队列有上限 | 队列满时丢事件，并调用 `lagSink` |
| handler 异常隔离 | 订阅者报错只进 `errorSink`，不会中断总线 |
| `close()` 优雅关闭 | 先停止接收新事件，再等待已排队事件处理完成 |

这说明它是事件分发器，不是可靠消息中间件。

---

## 4. 领域事件边界

不是所有运行时里出现的“事件”都算领域事件。

### 4.1 当前领域事件聚合

当前系统按下面几个聚合组织领域事件：

| 聚合 | 说明 |
|------|------|
| Session | 会话生命周期 |
| GraphRun | 图执行生命周期和节点执行 |
| Run | 单次 assistant 执行，包括消息和工具调用 |
| Task | 跨进程任务生命周期 |
| Node | worker 节点注册、重注册、离线 |

### 4.2 不属于领域事件的东西

下面这些不该直接建模成 `DomainEvent`：

| 类型 | 为什么不算领域事件 |
|------|--------------------|
| AG-UI 事件 | 这是前端协议格式，不是业务事实 |
| SSE 推送事件 | 这是传输通道上的对外形态 |
| OTel span / tracing 数据 | 这是可观测性数据，不是领域模型 |
| 普通结构化日志 | 这是诊断输出，不是领域事实 |
| 心跳类运维信号 | 更接近 metrics / health 状态 |

判断标准很简单：如果它描述的是“业务上发生了什么”，它更可能是领域事件；如果它描述的是“如何展示、如何传输、如何观察”，它就不该放进 Core 层。

---

## 5. 事件产生与发布

### 5.1 runtime 主入口

runtime 侧统一通过 `createRuntimeEventPipeline()` 把裸事件包装后发布：

```text
emitEvent(event)
  -> wrap(event)
  -> publish(envelope)
  -> 更新因果上下文
```

对应实现位于 `packages/runtime/src/bus/pipeline.ts`。

这条流水线做三件事：

| 步骤 | 作用 |
|------|------|
| 包装 envelope | 生成 `eventId`、补齐 `aggregateType`、`aggregateId`、`sequence` |
| publish | 投递到当前进程内 `EventBus` |
| 推进因果链 | 把当前事件的 `eventId` 设为后续事件的 `causationId` 来源 |

### 5.2 sequence 与恢复

每个聚合实例都要保证 `sequence` 单调递增。

当前实现分两层：

| 部件 | 职责 |
|------|------|
| `SequenceCounter` | 进程内维护 `${aggregateType}:${aggregateId}` 到当前序号的映射 |
| `SequenceRecoverer` | 首次看到某个聚合实例时，从持久化层恢复最大序号 |

`createEnvelopeWrapper()` 会在第一次遇到某个聚合实例时调用 recoverer，初始化后再开始递增。重复初始化同一个 key 会直接抛错，不做掩盖。

### 5.3 因果链

因果链由这三个字段支撑：

| 字段 | 作用 |
|------|------|
| `correlationId` | 一整条业务链的公共 ID |
| `causationId` | 当前事件直接由哪个事件触发 |
| `sequence` | 同一聚合实例内的局部顺序 |

这三者组合起来，可以回答三类问题：

1. 这批事件是不是同一条业务链
2. 某个事件是被谁直接触发的
3. 某个聚合内部事件的先后顺序是什么

---

## 6. 跨进程路径

### 6.1 node / daemon -> controlplane

node 侧的 `createForwarder()` 会订阅本地 bus，然后按批次把 envelope POST 到 controlplane。

```text
node bus
  -> forwarder subscribe
  -> BatchCommitter 聚合
  -> POST / events NDJSON
  -> cp ingest
```

这里有两个关键点：

| 规则 | 说明 |
|------|------|
| 不改写 envelope | 转发保留原始 `correlationId`、`causationId`、`source` |
| 提前过滤非法 writer | 必然会被 cp 拒绝的 envelope，node 侧先不转发 |

### 6.2 controlplane ingest

controlplane 收到外部 envelope 后，不直接写数据库，而是先做 writer 校验，再 publish 到 cp 本地 bus。

`apps/controlplane/src/ingest/events.ts` 的路径很简单：

```text
ingest(env)
  -> validateWriter(env)
  -> publish(env)
```

这样做的意义是：controlplane 也把“接收的跨进程事件”和“本进程内部事件”统一收拢到同一条 bus，再由下游订阅者各自消费。

---

## 7. 订阅者与消费路径

总线的核心价值不是发布动作本身，而是订阅者之间互不耦合。

### 7.1 event_log 落盘

controlplane 侧 `subscribeEventLog()` 会订阅全量 envelope，再用 `BatchCommitter` 批量写入 `EventLogStore`。

当前 SQLite 实现是 `SqliteEventLogStore`，写入表为 `event_log`。

落盘内容包含：

| 列 | 来源 |
|----|------|
| `event_id` | envelope `eventId` |
| `type` | envelope `type` |
| `occurred_at` | envelope `occurredAt` |
| `correlation_id` | envelope `correlationId` |
| `causation_id` | envelope `causationId` |
| `sequence` | envelope `sequence` |
| `aggregate_type` / `aggregate_id` | envelope 聚合归属 |
| `source_json` | envelope `source` |
| `payload_json` | envelope `payload` |

这个事件日志的用途是审计、排障和重放查询，不是业务主状态。

### 7.2 AG-UI 适配

controlplane 侧 `event-mapper.ts` 把 `DomainEventEnvelope` 翻译成 AG-UI `BaseEvent[]`。

它说明了一件很重要的事：前端需要的协议事件并不等于领域事件。领域事件是源头，AG-UI 事件是映射结果。

例如：

| 领域事件 | AG-UI 输出 |
|----------|-----------|
| `TaskStarted` | `STATE_DELTA(taskStatus=running)` |
| `MessageStarted` | `TEXT_MESSAGE_START` |
| `MessageDelta` | 文本流 / thinking 流事件 |
| `ToolCompleted` | `TOOL_CALL_END` + `TOOL_CALL_RESULT` |

也有部分领域事件当前不映射到 AG-UI，例如 `Session*`、`Node*`、`TaskObservationLost`。

### 7.3 Observer 日志适配

`packages/observer/src/logger/event-bus-adapter.ts` 会把 envelope 直接写成 trace 级别日志。

日志里会保留这些关键字段：

- `correlationId`
- `causationId`
- `sequence`
- `aggregateType`
- `aggregateId`
- `payload`

这让日志层也能按统一事件模型观察系统，而不是再维护一套平行格式。

---

## 8. 单 writer 约束

这套事件总线有一个非常重要的约束：同一个聚合实例，在同一时期只能有一个合法 writer。

### 8.1 为什么必须这样

如果多个进程同时给同一个聚合实例发事件，会立刻出现两个问题：

1. `sequence` 无法保证严格单调
2. event_log 无法判断哪个事件才是合法事实

所以系统要求 writer 归属必须稳定。

### 8.2 当前 writer 归属

| 聚合 | writer |
|------|--------|
| Session | 创建它的 daemon |
| GraphRun | 启动它的进程 |
| Run | 与所属 GraphRun 相同 |
| Task | node |
| Node | controlplane |

`TaskObservationLost` 属于观察性事件，由 controlplane 发射，用来表达“观察者确认 task writer 失联”，它不是 node 对 task 终态的伪造。

### 8.3 违规处理

writer 违规不是 warning，而是错误。

系统当前的原则是：

```text
发现 writer 不合法
  -> 直接抛错
  -> 不兜底，不重试，不猜测
```

这符合仓库当前的 Let it crash 原则。

---

## 9. 失败语义与系统约束

### 9.1 Let it crash

领域事件总线不是“尽量糊过去”的系统。下面这些问题都应该尽早暴露：

| 问题 | 当前行为 |
|------|----------|
| EventBus 已关闭后继续 `publish` | 直接抛错 |
| writer 校验失败 | 直接抛错 |
| sequence 初始化重复 | 直接抛错 |
| event_log 唯一约束冲突 | 直接失败 |

### 9.2 慢订阅者处理

总线给每个订阅者独立队列，但不是无限队列。

处理策略：

| 情况 | 行为 |
|------|------|
| 队列未满 | 正常入队 |
| 队列已满 | 丢弃新事件，并调用 `lagSink` |
| handler 抛错 | 进入 `errorSink`，其他订阅者继续运行 |

这再次说明它追求的是清晰和隔离，不是“永不丢消息”。

---

## 10. 事件流总览

把整条路径压缩成一张图，最容易理解。

```text
Runtime / Node / Controlplane 业务代码
  -> emit DomainEvent
  -> createRuntimeEventPipeline
  -> wrap DomainEventEnvelope
  -> publish 到本进程 EventBus
  -> 订阅者消费
       -> forwarder 转发到 cp
       -> event-log-subscriber 落盘 event_log
       -> event-mapper 翻译成 AG-UI 事件
       -> observer adapter 写结构化日志
```

如果只记一件事，就记这句：

`DomainEvent` 是业务事实，`DomainEventEnvelope` 是统一载体，`EventBus` 是分发通道，协议和日志都是订阅者。

---

## 11. 与其他文档的关系

| 文档 | 关系 |
|------|------|
| `01 - ARCHITECTURE.md` | 给出系统整体分层，这篇文档补事件总线这一条主线 |
| `03 - RUNTIME_DESIGN.md` | 解释 runtime 生命周期，这篇文档补 runtime 如何发事件 |
| `04 - OBSERVER_DESIGN.md` | 解释日志与 tracing，这篇文档说明它们如何订阅事件总线 |
| `docs/superpowers/specs/2026-04-14-event-bus-design.md` | 更偏设计推导和规则细节 |
| `docs/superpowers/plans/2026-04-14-event-bus/` | 更偏实施步骤，不应替代正式开发文档 |

正式开发文档优先回答“系统现在是什么”，而 superpowers 下的设计/计划文档更适合回答“这套东西是怎么设计出来的、分几步落地的”。
