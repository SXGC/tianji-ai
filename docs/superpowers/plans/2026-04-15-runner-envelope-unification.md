# Runner Envelope Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉 node 侧 runner / ACP 适配器手工伪造 `DomainEventEnvelope` 的路径，统一改为只产出 `DomainEvent`，再由 node runtime pipeline 生成唯一合法的 envelope，消除 `event_log` 被 `sequence=0` 脏事件污染的问题。

**Architecture:** 当前 `apps/node` 存在两套事件包装机制：`createRuntimeEventPipeline()` 会生成合法 envelope，而 ACP / in-process runner 又自行构造带 `inproc_*`、`acp_*`、`runner_*` 前缀、且 `sequence=0` 的 envelope。修复方案是把 runner 边界统一收窄到“只返回 `DomainEvent`”，由 `task-executor` 通过注入的 `emitEvent()` 统一发布，彻底收回 `eventId / sequence / correlationId / causationId / source` 的生成权。与此同时，补回归测试证明生产路径不再出现手工 envelope，最后补一份历史脏数据清理手册。

**Tech Stack:** TypeScript、Vitest、`@tianji/runtime` event pipeline、`apps/node` runner 实现、controlplane SQLite `event_log`。

---

## File Structure

- Modify: `apps/node/src/acp/runner-interface.ts`
- Modify: `apps/node/src/acp/in-process-runner.ts`
- Modify: `apps/node/src/acp/event-adapter.ts`
- Modify: `apps/node/src/acp/agent-runner.ts`
- Modify: `apps/node/src/task/task-executor.ts`
- Modify: `apps/node/src/node-runtime/controlplane-runtime.ts`
- Modify: `apps/node/src/daemon-entry.ts`
- Modify: `apps/node/src/acp/__tests__/in-process-runner.test.ts`
- Modify: `apps/node/src/__tests__/acp-agent-runner.test.ts`
- Modify: `apps/node/src/task/__tests__/task-executor.test.ts`
- Modify: `apps/node/src/__tests__/native-agent-integration.test.ts`
- Modify: `apps/node/src/__tests__/native-agent-routing-integration.test.ts`
- Modify: `apps/node/README.md`
- Create: `docs/development/10 - EVENT_LOG_DATA_REPAIR.md`

---

### Task 1: 收紧 Runner 边界，只允许返回 DomainEvent

**Files:**
- Modify: `apps/node/src/acp/runner-interface.ts`
- Modify: `apps/node/src/acp/in-process-runner.ts`
- Modify: `apps/node/src/acp/event-adapter.ts`
- Modify: `apps/node/src/acp/agent-runner.ts`
- Test: `apps/node/src/acp/__tests__/in-process-runner.test.ts`
- Test: `apps/node/src/__tests__/acp-agent-runner.test.ts`

- [ ] **Step 1: 完整阅读现有 runner 接口和 3 个实现文件**

Read:
- `apps/node/src/acp/runner-interface.ts`
- `apps/node/src/acp/in-process-runner.ts`
- `apps/node/src/acp/event-adapter.ts`
- `apps/node/src/acp/agent-runner.ts`
- `apps/node/src/acp/__tests__/in-process-runner.test.ts`
- `apps/node/src/__tests__/acp-agent-runner.test.ts`

Expected: 明确所有生产代码里手工构造 `DomainEventEnvelope` 的位置，确认接口改动面。

- [ ] **Step 2: 先写失败测试，明确 runner 不再返回 envelope 元数据**

在以下测试里补断言：

```ts
// apps/node/src/acp/__tests__/in-process-runner.test.ts
it('query returns DomainEvent items instead of hand-crafted envelopes', async () => {
  const items = await collectEvents(runner.query('hi'))

  expect(items[0]).toMatchObject({ type: 'RunStarted' })
  expect(items[0]).not.toHaveProperty('eventId')
  expect(items[0]).not.toHaveProperty('sequence')
  expect(items[0]).not.toHaveProperty('aggregateType')
})

// apps/node/src/__tests__/acp-agent-runner.test.ts
it('ACP adapter returns DomainEvent without synthetic eventId prefixes', async () => {
  const items = await collectEvents(runner.query('hello'))

  expect(items.some((item) => 'eventId' in item)).toBe(false)
})
```

- [ ] **Step 3: 运行失败测试，确认当前实现仍在手工造 envelope**

Run: `pnpm --filter @tianji/node test -- in-process-runner.test.ts acp-agent-runner.test.ts`

Expected: FAIL，失败原因应体现当前返回值里仍然带有 `eventId` / `sequence` / `aggregateType`。

- [ ] **Step 4: 修改 runner 接口，统一为 AsyncIterable<DomainEvent>**

目标改动：

```ts
// apps/node/src/acp/runner-interface.ts
import type { DomainEvent } from '@tianji/shared'

export interface AgentRunnerLike {
  connect(): Promise<void>
  query(prompt: string): AsyncIterable<DomainEvent>
  disconnect(): Promise<void>
}
```

```ts
// apps/node/src/acp/in-process-runner.ts
import type { DomainEvent } from '@tianji/shared'

async *query(prompt: string): AsyncIterable<DomainEvent> {
  ...
  yield event
}
```

```ts
// apps/node/src/acp/event-adapter.ts
import type { DomainEvent, RunId } from '@tianji/shared'

export function mapSessionUpdateToRuntimeEvent(
  notification: SessionNotification,
  runId: RunId
): DomainEvent | null {
  ...
  return {
    type: 'MessageDelta',
    runId,
    ...
  }
}
```

```ts
// apps/node/src/acp/agent-runner.ts
async *query(prompt: string): AsyncIterable<DomainEvent> {
  const eventBuffer: DomainEvent[] = []
  ...
  yield completedEvent
}
```

要求：
- 删除生产代码里的 `wrapInProcessEvent()`、`wrapRunEvent()`、`wrapRunCompletedEnvelope()` 这类 envelope 包装器。
- runner 只负责把 ACP / agent session 产出的 `DomainEvent` 暴露给上游。
- 不新增兜底逻辑，不保留兼容双模式接口。

- [ ] **Step 5: 运行 runner 相关测试，确认边界收紧后通过**

Run: `pnpm --filter @tianji/node test -- in-process-runner.test.ts acp-agent-runner.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交这一小步**

```bash
git add apps/node/src/acp/runner-interface.ts apps/node/src/acp/in-process-runner.ts apps/node/src/acp/event-adapter.ts apps/node/src/acp/agent-runner.ts apps/node/src/acp/__tests__/in-process-runner.test.ts apps/node/src/__tests__/acp-agent-runner.test.ts
git commit -m "refactor(node): make runners emit domain events only"
```

---

### Task 2: 把 task-executor 改成统一走 node runtime pipeline

**Files:**
- Modify: `apps/node/src/task/task-executor.ts`
- Modify: `apps/node/src/node-runtime/controlplane-runtime.ts`
- Modify: `apps/node/src/daemon-entry.ts`
- Test: `apps/node/src/task/__tests__/task-executor.test.ts`
- Test: `apps/node/src/__tests__/native-agent-integration.test.ts`
- Test: `apps/node/src/__tests__/native-agent-routing-integration.test.ts`

- [ ] **Step 1: 完整阅读 task executor 与注入边界**

Read:
- `apps/node/src/task/task-executor.ts`
- `apps/node/src/node-runtime/controlplane-runtime.ts`
- `apps/node/src/daemon-entry.ts`
- `apps/node/src/task/__tests__/task-executor.test.ts`
- `apps/node/src/__tests__/native-agent-integration.test.ts`
- `apps/node/src/__tests__/native-agent-routing-integration.test.ts`

Expected: 确认当前 `publishEnvelope(envelope)` 是直接绕开 pipeline 的唯一生产入口。

- [ ] **Step 2: 先写失败测试，锁定“runner 事件必须走 emitEvent”**

补一个测试，明确 task executor 不再接收预包装 envelope：

```ts
// apps/node/src/task/__tests__/task-executor.test.ts
it('publishes runner output via emitEvent instead of publishEnvelope', async () => {
  const emitEvent = vi.fn().mockResolvedValue(undefined)
  const publishEnvelope = vi.fn()

  const runner = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    async *query() {
      yield { type: 'RunStarted', runId: 'run-1', sessionId: 's-1', triggerType: 'new', timestamp: 1 }
      yield { type: 'RunCompleted', runId: 'run-1', sessionId: 's-1', triggerType: 'new', timestamp: 2 }
    },
  }

  await executor.execute(command)

  expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'RunStarted' }))
  expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'RunCompleted' }))
  expect(publishEnvelope).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: 运行失败测试，确认当前实现还在调用 publishEnvelope**

Run: `pnpm --filter @tianji/node test -- task-executor.test.ts native-agent-integration.test.ts native-agent-routing-integration.test.ts`

Expected: FAIL，失败点应指向 `publishEnvelope` 仍被调用，或 runner 返回类型不匹配。

- [ ] **Step 4: 最小实现：task executor 统一改用 emitEvent(event)**

目标改动：

```ts
// apps/node/src/task/task-executor.ts
import type { DomainEvent } from '@tianji/shared'

export interface TaskExecutorConfig {
  readonly emitEvent: (event: DomainEvent) => Promise<void> | void
}

for await (const event of runner.query(command.payload.goal)) {
  turn = await handleEvent(..., event)
  await this.#config.emitEvent(event)
}
```

```ts
// apps/node/src/node-runtime/controlplane-runtime.ts
readonly emitTaskEvent: (event: DomainEvent) => Promise<void>
```

```ts
// apps/node/src/daemon-entry.ts
emitTaskEvent: (ev) => {
  if (nodePipeline === null) {
    throw new Error('Node task event pipeline not initialized')
  }
  return nodePipeline.emitEvent(ev)
}
```

要求：
- 删除生产配置接口里的 `publishEnvelope`。
- `TaskStarted`、`Run*`、`MessageDelta`、`Tool*`、`TaskCompleted` 全部统一走 `nodePipeline.emitEvent()`。
- 不引入“双写”或“临时兼容”路径。

- [ ] **Step 5: 运行 node 侧集成测试，确认统一发布后通过**

Run: `pnpm --filter @tianji/node test -- task-executor.test.ts native-agent-integration.test.ts native-agent-routing-integration.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交这一小步**

```bash
git add apps/node/src/task/task-executor.ts apps/node/src/node-runtime/controlplane-runtime.ts apps/node/src/daemon-entry.ts apps/node/src/task/__tests__/task-executor.test.ts apps/node/src/__tests__/native-agent-integration.test.ts apps/node/src/__tests__/native-agent-routing-integration.test.ts
git commit -m "refactor(node): route runner events through runtime pipeline"
```

---

### Task 3: 补回归测试，证明生产路径不再生成伪造 envelope

**Files:**
- Modify: `apps/node/src/__tests__/native-agent-integration.test.ts`
- Modify: `apps/node/src/__tests__/native-agent-routing-integration.test.ts`
- Modify: `apps/node/src/task/__tests__/task-executor.test.ts`

- [ ] **Step 1: 给集成测试加显式断言，禁止伪 eventId 前缀与 sequence=0**

补以下断言骨架：

```ts
expect(publishedEnvelopes.every((env) => !env.eventId.startsWith('inproc_'))).toBe(true)
expect(publishedEnvelopes.every((env) => !env.eventId.startsWith('acp_'))).toBe(true)
expect(publishedEnvelopes.every((env) => !env.eventId.startsWith('runner_'))).toBe(true)
expect(publishedEnvelopes.every((env) => env.sequence >= 1)).toBe(true)
```

- [ ] **Step 2: 增加 Run 聚合 sequence 递增断言**

```ts
const runEvents = publishedEnvelopes.filter((env) => env.aggregateType === 'Run')
expect(runEvents.length).toBeGreaterThan(0)

for (let index = 1; index < runEvents.length; index += 1) {
  expect(runEvents[index].sequence).toBeGreaterThanOrEqual(runEvents[index - 1].sequence)
}
```

注意：如果同一测试里包含多个不同 `runId`，先按 `aggregateId` 分组，再分别断言递增。

- [ ] **Step 3: 运行回归测试，确认修复点被覆盖**

Run: `pnpm --filter @tianji/node test -- native-agent-integration.test.ts native-agent-routing-integration.test.ts task-executor.test.ts`

Expected: PASS，并且失败时能直接暴露“出现手工 eventId 前缀”或“出现 sequence=0”。

- [ ] **Step 4: 提交这一小步**

```bash
git add apps/node/src/__tests__/native-agent-integration.test.ts apps/node/src/__tests__/native-agent-routing-integration.test.ts apps/node/src/task/__tests__/task-executor.test.ts
git commit -m "test(node): cover runner envelope unification regression"
```

---

### Task 4: 写数据修复与文档更新

**Files:**
- Create: `docs/development/10 - EVENT_LOG_DATA_REPAIR.md`
- Modify: `apps/node/README.md`

- [ ] **Step 1: 完整阅读 node README，确定事件系统说明落点**

Read: `apps/node/README.md`

Expected: 找到 daemon / 日志 / 事件系统相关小节，补入“runner 不得手工构造 envelope”的约束。

- [ ] **Step 2: 新建数据修复文档，明确排查和清理步骤**

文档至少包含以下内容：

```md
# Event Log Data Repair

## 问题特征

- `event_id` 以 `inproc_` / `acp_` / `runner_` 开头
- `aggregate_type = 'Run'`
- `sequence = 0`

## 只读排查 SQL

SELECT event_id, type, occurred_at, sequence, aggregate_id, source_json
FROM event_log
WHERE aggregate_type = 'Run'
  AND sequence = 0
  AND (
    event_id LIKE 'inproc_%' OR
    event_id LIKE 'acp_%' OR
    event_id LIKE 'runner_%'
  )
ORDER BY occurred_at DESC;

## 清理前备份

先完整备份 `controlplane.db`。

## 删除 SQL

DELETE FROM event_log
WHERE aggregate_type = 'Run'
  AND sequence = 0
  AND (
    event_id LIKE 'inproc_%' OR
    event_id LIKE 'acp_%' OR
    event_id LIKE 'runner_%'
  );
```

要求：
- 明确这是一次性数据修复手册，不把 SQL 塞进生产代码。
- 明确先升级代码、后清数据、再验证。

- [ ] **Step 3: 在 `apps/node/README.md` 增加事件边界说明**

增加一小节，明确：

```md
## 事件边界约束

- runner / ACP adapter 只允许产出 `DomainEvent`。
- `DomainEventEnvelope` 只能由 node runtime pipeline 统一生成。
- 生产代码禁止手工构造带 `eventId`、`sequence`、`aggregateType`、`source` 的 envelope。
```

- [ ] **Step 4: 运行文档相关检查并提交**

Run: `pnpm --filter @tianji/node test -- --runInBand=false`

Expected: 现有 node 测试仍通过。

```bash
git add "docs/development/10 - EVENT_LOG_DATA_REPAIR.md" apps/node/README.md
git commit -m "docs(node): document event envelope boundary and repair steps"
```

---

### Task 5: 全量验证与人工数据库复查

**Files:**
- No code changes expected

- [ ] **Step 1: 运行 node 包测试**

Run: `pnpm --filter @tianji/node test`

Expected: PASS。

- [ ] **Step 2: 运行 controlplane 包测试，确认 ingest / event-log 相关行为未被破坏**

Run: `pnpm --filter @tianji/controlplane test`

Expected: PASS。

- [ ] **Step 3: 运行仓库级检查**

Run: `pnpm check`

Expected: PASS，无 error、warning、info 遗留。

- [ ] **Step 4: 人工验证日志与数据库**

1. 启动 controlplane 与 daemon。
2. 下发一个新 task。
3. 观察 `~/.config/tianji-ai/logs/tianji.log`。

期望：
- 不再出现 `event_id` 形如 `inproc_*` / `acp_*` / `runner_*`
- 不再出现 `UNIQUE constraint failed: event_log.aggregate_type, event_log.aggregate_id, event_log.sequence`

数据库复查命令（在可用 SQLite 环境中运行）：

```sql
SELECT event_id, type, sequence, aggregate_type, aggregate_id
FROM event_log
WHERE aggregate_type = 'Run'
  AND (
    event_id LIKE 'inproc_%' OR
    event_id LIKE 'acp_%' OR
    event_id LIKE 'runner_%' OR
    sequence = 0
  )
ORDER BY occurred_at DESC;
```

Expected: 新任务相关结果为空。

- [ ] **Step 5: 最终提交**

```bash
git status --short
git add <only-files-from-this-plan>
git commit -m "fix(node): unify event envelope creation through runtime pipeline"
```

---

## Self-Review

- Spec coverage: 本计划只覆盖“生产代码手工伪造 envelope 导致 event_log 污染”这一条主问题，不包含 controlplane 历史 daemon 错发 `TaskStarted` 的独立问题。
- Placeholder scan: 所有任务都给了具体文件、命令、断言方向和修改目标，没有留下 `TODO` 或“自行处理边界”的空话。
- Type consistency: 整个计划统一把 runner 输出收敛到 `DomainEvent`，由 `task-executor` 调用 `emitEvent()`，不再混用 `publishEnvelope()`。
