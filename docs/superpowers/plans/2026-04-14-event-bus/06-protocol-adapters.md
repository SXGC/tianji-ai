# 阶段 06：Protocol 适配器改造为 Bus 订阅者

> Spec：[../../specs/2026-04-14-event-bus-design.md](../../specs/2026-04-14-event-bus-design.md) §五
> 前置：阶段 02（Bus）、05（runtime 发 DomainEvent）
> 交付物：5 个适配器的输入从裸 `RuntimeEvent` / `TaskEvent` 切换为 `DomainEventEnvelope`，对外协议输出保持不变。

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

## 前置修复（Task 0）：contextRef 迁移到 AsyncLocalStorage

**背景：** Stage 05 在 `apps/controlplane/src/server.ts` 和 `apps/node/src/daemon-entry.ts` 中，
`contextRef` 是进程级共享的单例。并发 run 场景下多个请求会互相污染对方的 causation 链，
产生错误的 `causationId` 传播。

**必须在 Stage 06 开始前完成：**

1. 引入 `AsyncLocalStorage<CausalContext>`，替换 `contextRef = { current: CausalContext.root(...) }` 共享对象。
2. 在每个 run 入口（HTTP handler / ACP session 入口）用 `als.run(CausalContext.root(newCorrelationId), handler)` 建立独立上下文。
3. `createRuntimeEventPipeline` 的 `contextRef` 改为从 `als.getStore()` 读取当前上下文。
4. 对应调整 `pipeline.ts` 的 `CausalContextRef` 接口（或新增 `CausalContextProvider` 抽象）。
5. `pnpm check` 全绿后，删除 server.ts 和 daemon-entry.ts 中的 `TODO(Stage 06, Task 0)` 注释。

**涉及文件：**
- `apps/controlplane/src/server.ts`
- `apps/node/src/daemon-entry.ts`
- `packages/runtime/src/bus/pipeline.ts`
- `packages/runtime/src/bus/envelope-wrapper.ts`（如需）

**Goal:** 把 AG-UI / ACP（两向）/ Daemon SSE / OTel / Observer 5 个订阅者彻底改成 Bus 消费者；输入统一为 envelope，filter 按 spec §五 表指定；外部协议字节流保持不变。

**Architecture:** 每个适配器：
- 不再从 RxJS 订阅 rxjs `TaskEvent$`，改为 `bus.subscribe(filter, handler, { name })`。
- 适配器内部的事件→协议映射函数纯化为 `(env: DomainEventEnvelope) => ProtocolOutput[]`，单测可直接跑。
- 对旧"非 envelope 输入"的桥接代码全部删除。

**Tech Stack:** 现有 CopilotKit / ACP SDK / SSE / OTel / Observer 代码。

---

## File Structure

- Modify: `apps/controlplane/src/agents/event-mapper.ts`（AG-UI 映射）
- Modify: `apps/controlplane/src/agents/tianji-agent.ts`（Bus 订阅接入）
- Modify: `packages/agent/src/acp/event-mapper.ts`（ACP 内→外）
- Modify: `apps/node/src/acp/event-adapter.ts`（ACP 外→内）
- Modify: `packages/agent/src/daemon-protocol.ts`（Daemon SSE）
- Modify: `packages/agent/src/daemon-server.ts`（Bus 订阅接入 SSE）
- Modify: `packages/observer/src/tracing/*`（OTel）
- Modify: `packages/observer/src/logger/*`（Observer Logger）
- 对应 `__tests__` 同步调整

---

### Task 1: AG-UI event-mapper 输入改为 envelope（TDD-lite：现有测试改造）

**Files:**
- Modify: `apps/controlplane/src/agents/event-mapper.ts`
- Modify: `apps/controlplane/src/agents/__tests__/event-mapper.test.ts`
- Modify: `apps/controlplane/src/agents/tianji-agent.ts`

- [ ] **Step 1: 读取三个文件**

- [ ] **Step 2: 改 event-mapper 签名**

```ts
// 旧：
export function mapToAgUi(ev: RuntimeEvent | TaskEvent): BaseEvent[]
// 新：
import type { DomainEventEnvelope } from '@tianji/shared'
export function mapToAgUi(env: DomainEventEnvelope): BaseEvent[]
```

内部逻辑：`switch (env.type)` 按 spec §五 表改出。所有原来基于 `RuntimeEvent.type` 的 dot-case 分支替换为 PascalCase。`STATE_DELTA /taskStatus=*` 路径对应 `TaskStarted/Completed/Failed/Cancelled/Waiting`。

- [ ] **Step 3: 改测试期望**

现有测试大部分喂裸 event 断言输出 AG-UI 帧。改为喂 envelope：

```ts
function envelope(payload: DomainEvent): DomainEventEnvelope { /* 辅助 */ }
// 对每个断言把 mapToAgUi(rawEvent) 改为 mapToAgUi(envelope(rawEvent))
```

- [ ] **Step 4: 改 tianji-agent.ts 的订阅接入**

原来从 rxjs/轮询拉 `TaskEvent`，现在 `bus.subscribe` 全聚合：

```ts
const subscription = bus.subscribe(
  {},
  (env) => {
    const frames = mapToAgUi(env)
    for (const f of frames) copilotStream.push(f)
  },
  { name: 'ag-ui-adapter', queueSize: 10_000 },
)
```

- [ ] **Step 5: 跑 cp 测试**

```bash
pnpm --filter @tianji/controlplane test
```

- [ ] **Step 6: 提交**

```bash
git add apps/controlplane/src/agents
git commit -m "refactor(controlplane): AG-UI 适配器改为消费 DomainEventEnvelope"
```

---

### Task 2: ACP 适配器（两向）

**Files:**
- Modify: `packages/agent/src/acp/event-mapper.ts`
- Modify: `apps/node/src/acp/event-adapter.ts`
- Modify 对应测试

- [ ] **Step 1: 读取**

- [ ] **Step 2: 输入类型替换为 `DomainEventEnvelope`**

映射表（spec §四 / 盘点文档 §四）：

| envelope.type | ACP sessionUpdate |
|--------------|-------------------|
| MessageDelta(channel='text') | agent_message_chunk |
| MessageDelta(channel='thinking') | agent_thought_chunk |
| ToolStarted | tool_call |
| ToolCompleted | tool_call_update(completed) |
| ToolFailed | tool_call_update(failed) |
| 其他 | 不映射 |

filter：`{ aggregateType: ['Run'], type: ['MessageDelta','ToolStarted','ToolCompleted','ToolFailed'] }`。

- [ ] **Step 3: 改测试期望（喂 envelope）**

- [ ] **Step 4: 跑测试**

```bash
pnpm --filter @tianji/agent test
pnpm --filter @tianji/node test
```

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/acp apps/node/src/acp
git commit -m "refactor(acp): 适配器输入改为 DomainEventEnvelope"
```

---

### Task 3: Daemon SSE 适配器

**Files:**
- Modify: `packages/agent/src/daemon-protocol.ts`
- Modify: `packages/agent/src/daemon-server.ts`

- [ ] **Step 1: 读取**

- [ ] **Step 2: `chat.event` 内层载荷从 `RuntimeEvent` 改为 `DomainEventEnvelope`**

```ts
// 旧：
interface ChatEventFrame { event: 'chat.event'; data: RuntimeEvent }
// 新：
interface ChatEventFrame { event: 'chat.event'; data: DomainEventEnvelope }
```

CLI 侧消费方只打日志或展示，不需协议对等兼容（内部组件）。

- [ ] **Step 3: daemon-server 订阅 bus 并把 envelope 推给 SSE**

filter：`{ aggregateType: ['GraphRun','Run'] }`（spec §五：Graph + Run + Message + Tool；Message / Tool 是 Run 内 entity，其 envelope 的 aggregateType 仍是 `Run`）。

```ts
bus.subscribe(
  { aggregateType: ['GraphRun', 'Run'] },
  (env) => sseStream.send({ event: 'chat.event', data: env }),
  { name: 'daemon-sse', queueSize: 2_000 },
)
```

- [ ] **Step 4: 跑 agent / node 测试**

```bash
pnpm --filter @tianji/agent test
pnpm --filter @tianji/node test
```

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/daemon-protocol.ts packages/agent/src/daemon-server.ts
git commit -m "refactor(daemon-sse): chat.event 内层载荷切为 DomainEventEnvelope"
```

---

### Task 4: OTel 适配器

**Files:**
- Modify: `packages/observer/src/tracing/*`

- [ ] **Step 1: 读取 observer/tracing 全部文件**

- [ ] **Step 2: 把 span 产生点的输入改为 envelope**

filter：`{ type: ['RunStarted','RunCompleted','RunFailed','ToolStarted','ToolCompleted','ToolFailed'] }`。

```ts
bus.subscribe(
  { type: ['RunStarted','RunCompleted','RunFailed','ToolStarted','ToolCompleted','ToolFailed'] },
  (env) => handleSpanEvent(env),
  { name: 'otel-adapter' },
)
```

- [ ] **Step 3: 跑 observer 测试**

```bash
pnpm --filter @tianji/observer test
```

- [ ] **Step 4: 提交**

```bash
git add packages/observer/src/tracing
git commit -m "refactor(observer): OTel 适配器切为 DomainEventEnvelope"
```

---

### Task 5: Observer Logger

**Files:**
- Modify: `packages/observer/src/logger/*`

- [ ] **Step 1: 读取**

- [ ] **Step 2: 日志格式化方法输入从 RuntimeEvent 改为 envelope**

输出 JSONL 结构里新增 `correlationId / causationId / sequence / aggregateType / aggregateId` 字段（来自 envelope），payload 字段保留。

filter：全聚合 `{}`。

- [ ] **Step 3: 跑 observer 测试**

```bash
pnpm --filter @tianji/observer test
```

- [ ] **Step 4: 提交**

```bash
git add packages/observer/src/logger
git commit -m "refactor(observer): Logger 切为消费 DomainEventEnvelope 并追加因果字段"
```

---

### Task 6: 装配订阅者

**Files:**
- Modify: `apps/node/src/daemon-entry.ts` 或相应 wiring 点
- Modify: `apps/controlplane/src/server.ts` 或 wiring 点

- [ ] **Step 1: 在 daemon 进程装配 ACP(内→外)、Daemon SSE、Observer、OTel 订阅者**

- [ ] **Step 2: 在 cp 进程装配 AG-UI 订阅者、Observer（cp 侧事件）、OTel（如有 cp 侧 span）**

- [ ] **Step 3: 冒烟**

```bash
SMOKE_E2E=1 pnpm --filter @tianji/node test:smoke
```

- [ ] **Step 4: 提交**

```bash
git add apps/node apps/controlplane
git commit -m "feat(wiring): 装配 5 个 Bus 订阅者"
```

---

### Task 7: 整仓 check

- [ ] **Step 1: `pnpm check` 全绿**

- [ ] **Step 2: 若 README 提到事件管道/协议，读取并更新（CLAUDE.md 要求功能修改后检查 README）**

相关 README 候选：
- `packages/observer/README.md`
- `packages/agent/README.md`
- `apps/controlplane/README.md`

仅补充"输入改为 DomainEventEnvelope"一段，约 3-5 行。

- [ ] **Step 3: 提交**

```bash
git add packages/*/README.md apps/controlplane/README.md
git commit -m "docs: 更新 README 注明适配器输入切为 envelope"
```

---

## Self-Review Checklist

- [ ] 5 个适配器输入类型均为 `DomainEventEnvelope`。
- [ ] AG-UI / ACP 对外协议输出字节流未变（测试断言保持原协议帧形状）。
- [ ] 各适配器的 bus.subscribe filter 与 spec §五 表一致。
- [ ] Observer Logger JSONL 新增 correlationId/causationId/sequence 字段。
- [ ] 无 `any` / 无内联 import / 文件 < 800 行。
- [ ] `pnpm check` 全绿。
