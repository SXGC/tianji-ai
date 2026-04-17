# AG-UI 事件收尾闸门（AgUiEventGate）设计

> **日期**：2026-04-16
> **状态**：Draft（待 review）
> **作者**：brainstorming 对齐产出
> **范围**：`apps/controlplane/src/agents`

---

## 1. 背景

### 1.1 触发问题

前端 AG-UI 运行时报错：

```
Cannot send 'RUN_FINISHED' while text messages are still active
```

根因：tianji-agent 在发送终态事件（`RUN_FINISHED` / `RUN_ERROR`）前，没有保证所有已发出 `TEXT_MESSAGE_START` 的消息都收到对应的 `TEXT_MESSAGE_END`。AG-UI 协议对这一点是硬约束，违反时运行时拒绝接受终态事件，前端无法正确收束流。

### 1.2 现状缺陷

| # | 缺陷 | 位置 | 影响 |
|---|------|------|------|
| 1 | 没有"活跃文本消息"集合追踪 | `tianji-agent.ts:118` 只有布尔 `hasTextMessage` | 无法知道具体哪条消息漏发 END |
| 2 | 发 `RUN_FINISHED` / `RUN_ERROR` 前没有 flush 屏障 | `tianji-agent.ts:153-170` | 终态前必定带着活跃消息，触发协议告警 |
| 3 | 三种终态路径行为不对称 | `tianji-agent.ts:136-170` | `TaskCompleted` 有"任务已完成"兜底文本，`TaskFailed` / `TaskCancelled` 路径既无兜底也无闭合 |
| 4 | `TaskFailed` / `TaskObservationLost` 路径必定带未闭合 TEXT_MESSAGE | `event-mapper.ts:79-91` | 失败事件不会触发 `MessageCompleted`，已开的流无人关闭 |
| 5 | `TaskCancelled` 路径同样不会触发 `MessageCompleted` | `event-mapper.ts:95-101` | cancel 语义就是"中途打断"，活跃消息几乎必然存在 |

### 1.3 已有的相关约束

- `event-mapper.ts` 是**纯函数**，只做单事件映射，上下文仅含 `inThinking` 和 `taskId`，不负责生命周期追踪。
- `mapMessageCompleted(messageId, ctx)` 已经封装了标准关闭序列（处于 thinking 时发 `REASONING_MESSAGE_END` → `REASONING_END` → `TEXT_MESSAGE_END`；否则只发 `TEXT_MESSAGE_END`）。
- `event-mapper.ts` 的 `inThinking` 是单一布尔，隐含假设"同一时刻最多一个 thinking 流"。

---

## 2. 目标

| # | 目标 | 达成后的状态 |
|---|------|------|
| G1 | **AG-UI 协议合规** | 所有路径下，`RUN_FINISHED` / `RUN_ERROR` 发出时 `activeMessages` 必为空；`TEXT_MESSAGE_END` 总是出现在终态事件之前 |
| G2 | **三路径行为对称** | 正常完成、失败、取消路径在协议收尾这件事上走同一条闸门逻辑，无 if-else 分叉 |
| G3 | **bug 可观测** | 上游事件流缺失 `MessageCompleted` 时，error 日志带 runId 和泄漏 messageId 列表，不静默掩盖 |
| G4 | **对 event-mapper 零侵入** | 保持 `event-mapper.ts` 的纯函数性质和现有行为；`ctx.inThinking` 不迁移 |
| G5 | **可单测** | 闸门的所有核心行为（追踪、flush、重复 emit 防御、未调用 emitTerminal 的 dispose 补救）都能在不启动 EventBus 的情况下单测覆盖 |

---

## 3. 非目标

| 项 | 原因 |
|---|------|
| 不对 ACP 协议（`packages/agent/agent-bridge.ts`）做同类处理 | ACP 协议语义不同，且当前未踩同类告警。YAGNI |
| 不覆盖 `TOOL_CALL_START` / `TOOL_CALL_END` 的收尾 | 当前告警只涉及 TEXT_MESSAGE；tool call 未见同类问题，等出现再扩展 |
| 不删除 `TaskCompleted` 的"任务已完成"兜底文本 | 既有刻意设计，遵守 CLAUDE.md"删除看起来是有意设计的功能前必须先问"的规则 |
| 不为 `TaskFailed` / `TaskCancelled` 路径新增业务兜底文本 | 属于 UX 决策，不在本次协议修复范围内 |
| 不重构 `event-mapper.ts` 的 `ctx.inThinking` 为按 messageId 维护的 map | 映射器当前的全局布尔假设与 gate 解耦，gate 自己按 messageId 追踪 inThinking 状态，互不依赖 |
| 不引入跨协议的通用"事件闸基类" | 只有一个消费者，强行抽象反而绕。YAGNI |
| 不调整 AG-UI 终态语义（`TaskCancelled` 仍映射为 `RUN_FINISHED`） | 上游最近 commit（7d7e6f2）已明确此映射，本次不动 |

---

## 4. 总架构

### 4.1 组件关系

```
DomainEventEnvelope（来自 EventBus）
        │
        ▼
  event-mapper.mapToAgUi()            ← 纯函数，不动
        │
        ▼ AG-UI BaseEvent[]
        │
┌───────┴──────────────┐
│   AgUiEventGate      │
│  ────────────────    │
│  - active 集合        │ ← 观察 AG-UI 事件类型自行维护
│  - terminated 标志   │
│  emit(event)         │
│  emitTerminal(event) │
│  dispose()           │
└───────┬──────────────┘
        │ 转发给 subscriber.next
        ▼
   Observable subscriber
        │
        ▼
     前端 AG-UI 运行时
```

### 4.2 职责边界

- **event-mapper**：单个 DomainEvent → AG-UI BaseEvent[] 的纯翻译，不管生命周期。保持现状。
- **AgUiEventGate**：AG-UI 事件的**出口层**。职责有且仅有：
  1. 观察事件类型维护活跃 messageId 集合；
  2. 终态事件发出前 flush 所有活跃消息；
  3. 防止重复终态、防止终态后再 emit；
  4. dispose 时作为最后保险打日志暴露 bug。
- **tianji-agent.run()**：订阅 EventBus，拿到 BaseEvent[] 后**全部交给 gate**，不再直接 `subscriber.next`。

---

## 5. 组件：AgUiEventGate

### 5.1 接口

```ts
type Subscriber = { next(event: BaseEvent): void }

class AgUiEventGate {
  constructor(
    subscriber: Subscriber,
    context: { runId: string; threadId: string },
    logger: Logger,
  )

  /** 转发普通事件，按事件类型更新活跃集合 */
  emit(event: BaseEvent): void

  /** 在发送终态事件前先 flush 所有活跃消息 */
  emitTerminal(event: BaseEvent): void

  /** 查询终态是否已发送，用于调用方幂等判断 */
  alreadyTerminated(): boolean

  /** Observable 收尾时调用；活跃非空则 flush + error 日志 */
  dispose(): void
}
```

选择 class 形态的原因：`private` 语义最强，易 mock，单测中 `new AgUiEventGate(mockSubscriber, ...)` 直接注入即可。

### 5.2 内部状态

```ts
private active: Map<string, { inThinking: boolean }>  // messageId → 状态
private terminated: boolean                            // emitTerminal 已调用
private disposed: boolean                              // dispose 已调用
```

- `active` 的 key 是 messageId，value 只存一个字段 `inThinking`；不需要存其他字段。
- 为什么每条 message 单独记 `inThinking`：gate 不依赖 `event-mapper.ctx.inThinking`（那是全局布尔），而是根据自己看到的 `REASONING_START` / `REASONING_END` 事件对应地更新每个 messageId 的 inThinking 字段。这样即使未来 event-mapper 放开多 thinking 流的限制，gate 也能正确处理。

### 5.3 emit 的事件类型处理

| 事件类型 | gate 行为 |
|----------|-----------|
| `TEXT_MESSAGE_START` | `active.set(messageId, { inThinking: false })` |
| `REASONING_START` | 若 `active` 已有此 id，标记 `inThinking=true`；若无（REASONING 先到，TEXT 未到），新增条目 `{ inThinking: true }`（当前 event-mapper 流程下不会出现此分支，属防御式处理） |
| `REASONING_END` | 若 `active` 有此 id，标记 `inThinking=false` |
| `TEXT_MESSAGE_END` | `active.delete(messageId)` |
| 其他所有类型 | 原样透传，不更新状态 |

所有情况在更新状态后都调用 `subscriber.next(event)`。

注意：`REASONING_MESSAGE_START` / `REASONING_MESSAGE_END` / `REASONING_MESSAGE_CONTENT` / `TEXT_MESSAGE_CONTENT` 等"流内事件"对 gate 透明，**不更新 active**，只透传。

### 5.4 emitTerminal 的 flush 行为

前置：`terminated === false`，否则直接忽略并打 warn 日志（防止并发下重复发终态）。

流程：
1. 若 `active.size > 0`，视为上游 bug：
   - 按 `active` 的 **Map 插入顺序**遍历每个 messageId（JS Map 保证插入顺序），顺序决定 flush 序列中的消息先后关系。
   - 对每个 messageId，按该条的 `inThinking` 决定发射顺序：
     - `inThinking=true`：依次发射 `REASONING_MESSAGE_END` → `REASONING_END` → `TEXT_MESSAGE_END`；
     - `inThinking=false`：发射 `TEXT_MESSAGE_END`。
   - 每个 id flush 完毕从 `active` 删除。
   - **打 error 日志**：包含 `runId`、`threadId`、泄漏的 messageId 列表、对应 inThinking 状态。日志级别 `error`（按 CLAUDE.md"catch 异常时使用 error level"的精神，这是上游的契约违反，属于"被动捕获的异常"）。
2. `active` 清空后，`subscriber.next(terminalEvent)`。
3. `terminated = true`。

### 5.5 emit 在终态后的防御

`terminated === true` 时，`emit` 变成空操作并打 `warn` 级日志（事件类型 + runId）。理由：终态之后再出现 AG-UI 事件说明时序错乱，但不应该再抛异常影响当前 Observable 的正常收尾。

### 5.6 dispose 的兜底

`dispose` 由 tianji-agent 在 `subscriber.complete()` 之前调用。

- 若 `terminated === true`：正常路径，active 必为空（emitTerminal 已清空），无事发生。
- 若 `terminated === false` 且 `active.size > 0`：说明业务方忘了调 `emitTerminal`。
  - gate **不会**擅自发终态事件（终态属于业务决策，gate 不知道该发 `RUN_FINISHED` 还是 `RUN_ERROR`）；
  - 但会 flush 所有活跃消息并打 **error 日志**，至少把协议已发出去的"半条消息"收束掉。
- `disposed = true`。重复调用 `dispose` 是空操作。

---

## 6. 数据流：三种终态路径

### 6.1 路径 A：正常完成（TaskCompleted）

```
EventBus
  │  TaskStarted
  │    → mapToAgUi → STATE_DELTA(running)
  │    → gate.emit → subscriber.next
  │
  │  MessageStarted(mid=M1)
  │    → mapToAgUi → TEXT_MESSAGE_START(M1)
  │    → gate.emit → active.set(M1, {inThinking: false}); subscriber.next
  │
  │  MessageDelta(mid=M1, channel=text)
  │    → mapToAgUi → TEXT_MESSAGE_CONTENT(M1)
  │    → gate.emit → 透传
  │
  │  MessageCompleted(mid=M1)
  │    → mapToAgUi → TEXT_MESSAGE_END(M1)
  │    → gate.emit → active.delete(M1); subscriber.next
  │
  │  TaskCompleted
  │    → mapToAgUi → STATE_DELTA(completed)
  │    → gate.emit
  │
  │  [tianji-agent 判断：hasTextMessage=true，跳过兜底文本]
  │  [tianji-agent 判断：gate.active.size === 0，构造 RUN_FINISHED]
  │    → gate.emitTerminal(RUN_FINISHED) → 直接转发
  │
  │  gate.dispose() → 空操作
  │  subscriber.complete()
```

### 6.2 路径 B：失败（TaskFailed / TaskObservationLost）

```
EventBus
  │  ...
  │  MessageStarted(mid=M1)
  │    → TEXT_MESSAGE_START(M1)
  │    → gate.emit → active = {M1: false}
  │
  │  MessageDelta...（未到 MessageCompleted）
  │
  │  TaskFailed
  │    → mapToAgUi → STATE_DELTA(failed), RUN_ERROR(msg)
  │    → gate.emit(STATE_DELTA) → 透传
  │    → [tianji-agent 识别 RUN_ERROR 为终态，改走 emitTerminal]
  │    → gate.emitTerminal(RUN_ERROR)
  │         → 检测 active={M1:false}，flush：发 TEXT_MESSAGE_END(M1)
  │         → 打 error 日志："active text messages on terminal: [M1]"
  │         → 发 RUN_ERROR
  │
  │  gate.dispose() → active 已空，空操作
  │  subscriber.complete()
```

注意 event-mapper 对 `TaskFailed` 已经内联发出了 `RUN_ERROR` 事件。改造后：tianji-agent 的订阅回调识别"BaseEvent 是不是终态事件"，只要是就走 `emitTerminal`。

### 6.3 路径 C：取消（TaskCancelled → RUN_FINISHED）

```
EventBus
  │  ...
  │  MessageStarted(mid=M1)
  │    → TEXT_MESSAGE_START(M1)
  │    → gate.emit → active = {M1: false}
  │
  │  MessageDelta(mid=M1, channel=thinking)
  │    → REASONING_START(M1), REASONING_MESSAGE_START(M1), REASONING_MESSAGE_CONTENT(M1)
  │    → gate.emit(REASONING_START) → active = {M1: true}
  │    → 其余透传
  │
  │  [用户点取消 → TaskCancelled 发出，MessageCompleted 永不到达]
  │
  │  TaskCancelled
  │    → mapToAgUi → STATE_DELTA(cancelled)
  │    → gate.emit → 透传
  │    → [tianji-agent 识别为终态，构造 RUN_FINISHED(reason='cancelled')]
  │    → gate.emitTerminal(RUN_FINISHED)
  │         → 检测 active={M1:true}，flush：
  │            发 REASONING_MESSAGE_END(M1), REASONING_END(M1), TEXT_MESSAGE_END(M1)
  │         → 打 error 日志
  │         → 发 RUN_FINISHED
  │
  │  gate.dispose() → 空操作
  │  subscriber.complete()
```

---

## 7. 迁移点：`tianji-agent.ts` 的改造

### 7.1 订阅回调改造

当前逻辑（概述）：
```
subscribe(env => {
  const events = mapToAgUi(env, ctx)
  for (const e of events) {
    subscriber.next(e)
    if (e.type === TEXT_MESSAGE_START) hasTextMessage = true
  }
  if (TERMINAL_TASK_TYPES.has(env.type)) {
    if (!hasTextMessage && env.type === 'TaskCompleted') {
      // 兜底文本
    }
    if (!sawTerminalAgUiEvent) subscriber.next(RUN_FINISHED / RUN_ERROR)
    subscription.unsubscribe()
    subscriber.complete()
  }
})
```

改造后：
```
const gate = new AgUiEventGate(subscriber, { runId, threadId }, logger)

subscribe(env => {
  const events = mapToAgUi(env, ctx)
  for (const e of events) {
    if (isTerminalAgUiEvent(e)) gate.emitTerminal(e)
    else gate.emit(e)
  }
  if (TERMINAL_TASK_TYPES.has(env.type)) {
    // 兜底文本：TaskCompleted 且整个 run 未发过文本
    if (!hasTextMessage && env.type === 'TaskCompleted') {
      gate.emit(TEXT_MESSAGE_START(fallbackId))
      gate.emit(TEXT_MESSAGE_CONTENT(fallbackId, '任务已完成'))
      gate.emit(TEXT_MESSAGE_END(fallbackId))
    }
    // 补发 RUN_FINISHED（event-mapper 只对 TaskFailed 内联了 RUN_ERROR）
    if (!gate.alreadyTerminated()) {
      gate.emitTerminal(buildTerminalEvent(env))
    }
    subscription.unsubscribe()
    gate.dispose()
    subscriber.complete()
  }
})
```

说明：
- `isTerminalAgUiEvent(e)`：判断是否为 `RUN_FINISHED` / `RUN_ERROR`。用于 event-mapper 对 `TaskFailed` 内联产出的 `RUN_ERROR`。实现位置：tianji-agent.ts 私有辅助函数。
- `hasTextMessage` 布尔**保留在 tianji-agent 侧**，不并入 gate。理由：这个布尔服务的是"任务完成时是否需要兜底文本"这一 UX 决策，和 gate 的协议合规职责是两件事，分离关注点。
- `gate.alreadyTerminated()` 用于调用方判断是否还需要补发终态事件；`emitTerminal` 自身也是幂等的（第二次调用空操作 + warn），两层保险并存。

### 7.2 `sawTerminalAgUiEvent` 变量废弃

原逻辑靠它防止重复发终态；新逻辑由 gate 内部 `terminated` 标志承担。tianji-agent 侧这个变量删除。

---

## 8. 错误处理

| 场景 | gate 行为 | 日志 |
|------|-----------|------|
| 上游缺失 `MessageCompleted`，`emitTerminal` 时 active 非空 | flush 所有活跃消息后发终态 | `error`：runId + threadId + messageIds |
| `emitTerminal` 被重复调用 | 第二次及以后变空操作 | `warn`：重复终态 |
| `emit` 在 `terminated` 后被调用 | 空操作 | `warn`：终态后 late event + 事件类型 |
| `dispose` 时仍有活跃消息且未终态 | flush，**不发终态事件** | `error`：runId + messageIds + "terminal not called" |
| gate 构造时 subscriber 或 logger 为 null | 按 CLAUDE.md "Let it crash"，直接抛错 | — |

所有 `error` 日志走 controlplane 的 logger，格式与现有一致（结构化字段 `runId` / `threadId` / `messageIds`）。

---

## 9. 测试方案

### 9.1 单元测试（直接 new AgUiEventGate）

测试文件建议：`apps/controlplane/src/agents/__tests__/ag-ui-event-gate.test.ts`。

| # | 用例 | 断言 |
|---|------|------|
| T1 | 正常路径：START → CONTENT → END → RUN_FINISHED | subscriber 按顺序收到 4 个事件；active 空；无 error 日志 |
| T2 | 失败路径：START 后直接 RUN_ERROR | subscriber 收到 START、TEXT_MESSAGE_END、RUN_ERROR；顺序严格；error 日志带 messageId |
| T3 | 取消路径（含 thinking）：TEXT_START → REASONING_START → RUN_FINISHED | subscriber 收到 TEXT_START、REASONING_START、REASONING_MESSAGE_END、REASONING_END、TEXT_MESSAGE_END、RUN_FINISHED；顺序严格；error 日志 |
| T4 | 多活跃消息：M1 START、M2 START 后 RUN_FINISHED | M1、M2 都收到 TEXT_MESSAGE_END；error 日志列出两个 id |
| T5 | 重复 emitTerminal | 第二次被忽略；warn 日志 |
| T6 | 终态后再 emit | 空操作；warn 日志 |
| T7 | 业务方忘记 emitTerminal，直接 dispose 且 active 非空 | flush 但不发终态事件；error 日志 |
| T8 | `TEXT_MESSAGE_START` 未到、直接 `REASONING_START` | active 新增条目 `{inThinking:true}`；后续 REASONING_END 标记为 false；TEXT_MESSAGE_END 从 active 删除 |

### 9.2 集成测试（走 tianji-agent 订阅链）

测试文件建议：`apps/controlplane/src/agents/__tests__/tianji-agent.gate.integration.test.ts`（或合并到现有 tianji-agent 测试文件）。

构造 mock EventBus 和 mock subscriber，通过 `TianjiAgent.run()` 走完整订阅链：

| # | 用例 | 断言 |
|---|------|------|
| I1 | 成功路径 E2E | subscriber 最后一个事件是 `RUN_FINISHED`；之前所有 TEXT_MESSAGE 都已 END；无 error 日志 |
| I2 | 失败路径 E2E（MessageStarted → TaskFailed） | subscriber 事件序列里 `TEXT_MESSAGE_END` 出现在 `RUN_ERROR` 之前；有 error 日志 |
| I3 | 取消路径 E2E（MessageStarted → thinking delta → TaskCancelled） | 序列里 `REASONING_END` 和 `TEXT_MESSAGE_END` 都出现在 `RUN_FINISHED(reason=cancelled)` 之前；有 error 日志 |
| I4 | 空内容 TaskCompleted | 发"任务已完成"兜底文本，START/CONTENT/END 齐全；gate 无泄漏 |

### 9.3 运行命令

- 单测：`pnpm --filter @tianji/controlplane test -- ag-ui-event-gate`
- 集成：`pnpm --filter @tianji/controlplane test -- tianji-agent.gate`
- 结束前必须走 `pnpm check`（CLAUDE.md 要求）

---

## 10. 边界与风险

| # | 风险 | 缓解 |
|---|------|------|
| 1 | `event-mapper.ctx.inThinking` 与 gate 自维护的 `inThinking` 冗余，可能漂移 | 两者数据源不同但互不依赖：mapper 决定"是否该发 REASONING_START 事件"，gate 决定"flush 时该发什么结束序列"。漂移只会导致某一路 inThinking 多或少一次 END，单测 T3/T8 覆盖。 |
| 2 | 多条 TEXT_MESSAGE 并发（M1 未完 M2 已开） | 当前 event-mapper 的映射器允许，但实际业务是否会产生不确定。gate 用 Map 按 messageId 分开管理，天然支持。 |
| 3 | `TaskFailed` 事件同时触发两个终态源：event-mapper 内联的 `RUN_ERROR` 和 tianji-agent 补发的 `RUN_ERROR` | 靠 gate 内部 `terminated` 幂等；第二次 `emitTerminal` 被忽略并 warn。单测 T5 覆盖。 |
| 4 | Observable unsubscribe 的时序 | 现有代码 `subscription.unsubscribe()` 在 `subscriber.complete()` 之前，gate.dispose() 插在两者之间；不改变可观测顺序。 |
| 5 | logger 注入带来的测试依赖 | 单测用 spy logger；集成测试按需要注入 silent logger。 |
| 6 | 未来 tool call 也触发同类告警 | 本次不处理。扩展方向：gate 新增 `activeToolCalls` 集合，接口形态稳定不变。设计已留扩展余地。 |
| 7 | event-mapper 对 `TaskObservationLost` 目前无映射（`default: return []`），只有 controlplane 顶层兜底发 `RUN_ERROR` | 新设计下 controlplane 顶层补发的 `RUN_ERROR` 走 `gate.emitTerminal`，flush 正常触发。路径对称。 |

---

## 11. 开放问题

无。本 spec 的所有取舍已在 brainstorming 阶段对齐：
- Gate 范围：AG-UI 专属（1A）
- 非空终态处置：flush + error 日志（2B）
- 追踪范围：TEXT_MESSAGE + 对应 REASONING 收尾（3A）
- 耦合方式：gate 观察 AG-UI 事件（4A）
- 兜底文本：保留 TaskCompleted 的"任务已完成"，其他路径不加（5A）
- 接口形态：class（细化阶段 β）

---

## 12. 参考

- `apps/controlplane/src/agents/tianji-agent.ts:118-176`：当前终态处理逻辑
- `apps/controlplane/src/agents/event-mapper.ts:385-396`：`mapMessageCompleted` 的标准关闭序列
- `apps/controlplane/src/agents/event-mapper.ts:122-141`：`MessageStarted` / `MessageDelta` / `MessageCompleted` 映射
- Commit `7d7e6f2`：TaskCancelled 映射为 RUN_FINISHED 的决策
- AG-UI 协议约束：`Cannot send 'RUN_FINISHED' while text messages are still active`
