# Task 生命周期事件对齐与取消命令通路 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `superpowers:subagent-driven-development`（CLAUDE.md 默认）逐任务实施。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 GraphRun / Run / Task 三层聚合在成功/失败/取消三条路径上的生命周期事件完整闭环，同时新建用户主动取消 task 的命令通路，让前端能感知失败原因并支持主动取消。

**Architecture:** 基于 spec `docs/superpowers/specs/2026-04-16-task-lifecycle-events-and-cancel-command.md`。复用现有 `commands` 表 + `command_poll` 长轮询通路（不新建传输通道）；新增 `GraphRunCancelled` 事件；改造 `task-executor` 按 Run 终端事件类型正确分发 Task 终端事件；透传原始 error 到前端。分三阶段（P1 失败对齐 → P2 取消事件 → P3 取消命令通路），每阶段独立可交付、可测试、可回滚。

**Tech Stack:** TypeScript / pnpm monorepo / Vitest / Better-SQLite3 / CopilotKit (AG-UI) / LangGraph

---

## 前置约定

| 约定 | 细则 |
|---|---|
| **工作目录** | 每个 Phase 启动前，执行者先用 `git status` 确认工作树干净；如有未提交改动，先收尾（问用户）再开始 |
| **测试运行** | 必须从对应包根目录执行：`pnpm --filter <package> test`，禁止从仓库根目录 |
| **commit** | 必须先加载 `git-commit` skill；禁止添加 `Co-Authored-By`；提交前跑 `pnpm check` 并修完所有 error/warning |
| **代码展示** | Plan 里只给伪代码 / 函数签名 / 关键结构；完整实现由执行者在 subagent 中产出 |
| **回滚点** | 每个 Task 的 commit 点都是安全回滚点 |

---

## 文件结构映射

### Phase 1（失败路径）涉及文件

| 类别 | 路径 | 责任 |
|---|---|---|
| 实现 | `packages/runtime/src/runtime/run-lifecycle.ts` | Run 终端事件发射；改造 `handleRunFailure` 透传原始 error |
| 实现 | `apps/node/src/task/task-executor.ts` | 改造 for-await 循环记忆 Run 终端类型，循环结束按类型分发 Task 终端 |
| 测试 | `packages/runtime/src/__tests__/run-lifecycle.test.ts` | 验证 error 透传 |
| 测试 | `apps/node/src/task/__tests__/task-executor.test.ts` | 验证三种 Run 终端分别导致正确的 Task 终端 |

### Phase 2（取消事件）涉及文件

| 类别 | 路径 | 责任 |
|---|---|---|
| 新增 | `packages/shared/src/events/graph-run.ts` | `GraphRunCancelledEvent` 类型定义，加入 union |
| 实现 | `packages/shared/src/index.ts` | 导出新类型（如需） |
| 实现 | `packages/runtime/src/bus/event-target.ts` | `resolveTarget` 支持 `GraphRunCancelled` |
| 实现 | `packages/agent/src/orchestration/graph-runner.ts` | catch 块区分 AbortError → `GraphRunCancelled` |
| 实现 | `packages/runtime/src/runtime/run-lifecycle.ts` | 识别 AbortError 发 `RunCancelled(reason='abort')` |
| 实现 | `apps/node/src/task/task-executor.ts` | 扩展分发表加 `RunCancelled → TaskCancelled` |
| 测试 | 对应 `__tests__` 目录 | 单元测试 |

### Phase 3（命令通路）涉及文件

| 类别 | 路径 | 责任 |
|---|---|---|
| 实现 | `packages/shared/src/command.ts` | `Command` 改 discriminated union；新增 `TaskCancelPayload` |
| 实现 | `apps/controlplane/src/routes/command-poll.ts` | `PollCommandResponse` 类型同步 |
| 新增 | `apps/node/src/task/active-executor-registry.ts` | 进程级注册表 |
| 实现 | `apps/node/src/task/task-executor.ts` | 暴露 `cancel()` 方法 |
| 实现 | `apps/node/src/daemon-entry.ts` 或 command 消费路径 | 按 `command.type` 分发 |
| 实现 | `apps/controlplane/src/agents/tianji-agent.ts` | `cancelTask()` 方法 |
| 实现 | `apps/controlplane/src/routes/copilot.ts` 或新路由 | HTTP 入口 |
| 实现 | `apps/controlplane/src/agents/event-mapper.ts` | `TaskCancelled` → AG-UI 映射 |
| 测试 | 各对应 `__tests__` 目录 | 单元 + 集成 |
| 文档 | `apps/node/README.md`, `apps/controlplane/README.md`, `docs/development/09 - EVENT_BUS_DESIGN.md` | 同步更新 |

---

# Phase 1：失败路径对齐

**目标**：解决用户贴出的 `ProviderError 500 empty_stream` 日志痛点。改造完成后，此场景下前端能收到 `code='PROVIDER_ERROR'` 的失败信号。

**独立价值**：完成 Phase 1 即可独立交付，不依赖 Phase 2/3。

---

### Task 1.1：run-lifecycle 透传原始 error（不再重包装）

**Files:**
- Modify: `packages/runtime/src/runtime/run-lifecycle.ts`（`handleRunFailure` 或等价函数）
- Test: `packages/runtime/src/__tests__/run-lifecycle.test.ts`

**背景**：当前 `run-lifecycle` 从 graph-runner 收到异常后，发 `RunFailed` 时把 error 重新包装。要改成透传原始 `{ name, code, message }`。

- [ ] **Step 1：读透现状**

Read: `packages/runtime/src/runtime/run-lifecycle.ts` 完整文件，聚焦 `RunFailed` 发射点附近（spec 引用的 264-268 行附近）。理解当前 error 传入时的包装逻辑。

- [ ] **Step 2：写失败测试**

在 `run-lifecycle.test.ts` 新增测试：

```ts
// 关键断言骨架
it('RunFailed 事件透传 GraphRunFailed.error 的 name/message', () => {
  const originalError = { name: 'ProviderError', message: '500 empty_stream' }
  // 触发 run-lifecycle 的失败路径，传入 originalError
  // 断言：发出的 RunFailed.error.name === 'ProviderError'
  // 断言：发出的 RunFailed.error.message === '500 empty_stream'
  // 断言：error 不是 TianjiError 壳（或如果是壳，外壳保留的前提下原字段可还原）
})
```

- [ ] **Step 3：运行测试确认失败**

```bash
pnpm --filter @tianji/runtime test -- run-lifecycle
```
Expected: 新测试 FAIL（error 被包装丢失了原始字段）

- [ ] **Step 4：修改 run-lifecycle**

改造点（伪代码层面）：
- `handleRunFailure(error)` 函数不再包装 error
- 直接取 `error.name`、`error.message`，构造 `RunFailed.error` payload（shared 类型已支持）
- 若原 error 是标准 `Error` 实例，保留 name/message；若是 structured object，原样透传

- [ ] **Step 5：运行测试确认通过**

```bash
pnpm --filter @tianji/runtime test -- run-lifecycle
```
Expected: PASS

- [ ] **Step 6：跑 pnpm check**

```bash
pnpm check
```
Expected: 零 error / warning

- [ ] **Step 7：commit**

加载 `git-commit` skill 生成 commit message。参考主题：`fix(runtime): 透传原始 error 到 RunFailed，不再重包装`

---

### Task 1.2：task-executor 记忆 Run 终端并分发正确的 Task 终端

**Files:**
- Modify: `apps/node/src/task/task-executor.ts:107-132`
- Test: `apps/node/src/task/__tests__/task-executor.test.ts`

**背景**：当前 for-await 结束后无条件发 `TaskCompleted`。改造为根据记忆的最后 Run 终端事件类型分发。

- [ ] **Step 1：写失败测试（RunCompleted → TaskCompleted）**

```ts
it('Run 成功完成时发 TaskCompleted', async () => {
  // 构造 fake runner，yield RunStarted + MessageCompleted + RunCompleted
  // 执行 TaskExecutor.execute
  // 断言：emitEvent 调用记录里最后一个 Task 终端是 TaskCompleted
})
```

- [ ] **Step 2：写失败测试（RunFailed → TaskFailed 透传 error）**

```ts
it('Run 失败时发 TaskFailed，error.code 透传自 RunFailed.error.name', async () => {
  // 构造 fake runner，yield RunStarted + RunFailed({error:{name:'ProviderError',message:'500 empty_stream'}})
  // 执行 TaskExecutor.execute
  // 断言：emit 的 TaskFailed.error.code === 'PROVIDER_ERROR'（或 'ProviderError'，按最终命名约定）
  // 断言：TaskFailed.error.message === '500 empty_stream'
})
```

> 注：Phase 1 先实现 `RunFailed → TaskFailed` 分支。`RunCancelled → TaskCancelled` 分支留到 Phase 2（此时 RunCancelled 事件通路尚不完整）。

- [ ] **Step 3：写失败测试（循环异常中止 → TaskFailed 透传异常）**

```ts
it('for-await 流抛异常时，catch 发 TaskFailed，error 透传', async () => {
  // 构造 fake runner，yield RunStarted 后立即 throw new ProviderError
  // 期望：catch 块发出的 TaskFailed.error 透传异常的 name/message
})
```

- [ ] **Step 4：运行测试确认失败**

```bash
pnpm --filter @tianji/node test -- task-executor
```
Expected: 三个新测试 FAIL

- [ ] **Step 5：改造 task-executor.execute**

改造要点（伪代码骨架）：

```ts
let lastRunTerminalType: 'RunCompleted' | 'RunFailed' | 'RunCancelled' | null = null
let lastRunFailedEvent: RunFailedEvent | null = null

for await (const event of runner.query(...)) {
  turn = await handleEvent(...)
  if (event.type === 'RunCompleted' || event.type === 'RunFailed' || event.type === 'RunCancelled') {
    lastRunTerminalType = event.type
    if (event.type === 'RunFailed') lastRunFailedEvent = event
  }
  emitEvent(event)
  // mirror 消息事件不变
}

if (lastRunTerminalType === null) throw new Error('Agent run ended without a terminal event')

// 按类型分发
if (lastRunTerminalType === 'RunCompleted') {
  emitEvent({ type: 'TaskCompleted', taskId, timestamp: now() })
} else if (lastRunTerminalType === 'RunFailed') {
  emitEvent({
    type: 'TaskFailed',
    taskId,
    timestamp: now(),
    error: new TianjiError('internal', lastRunFailedEvent!.error.name, lastRunFailedEvent!.error.message),
  })
}
// RunCancelled 分支在 Phase 2.5 加
```

**关键要点**：
- `code` 字段 = 原 error name（例如 `ProviderError`），保留原始诊断语义
- `category` 维持 `'internal'`（现有默认）
- `message` 原样透传

- [ ] **Step 6：运行测试确认通过**

```bash
pnpm --filter @tianji/node test -- task-executor
```
Expected: 三个新测试 PASS，原有测试也 PASS

- [ ] **Step 7：pnpm check**

```bash
pnpm check
```
Expected: 零 error / warning

- [ ] **Step 8：commit**

参考主题：`fix(node): task-executor 按 Run 终端分发 Task 终端并透传 error`

---

### Task 1.3：Phase 1 回归验收

- [ ] **Step 1：回归相关 package 的全量测试**

```bash
pnpm --filter @tianji/runtime test
pnpm --filter @tianji/node test
```
Expected: 全部 PASS

- [ ] **Step 2：冒烟测试**

```bash
SMOKE_E2E=1 pnpm --filter @tianji/node test:smoke
```
Expected: PASS

- [ ] **Step 3：确认验收标准**

| 标准 | 验证方法 |
|---|---|
| 贴出的 ProviderError 日志场景能产出带 `code='ProviderError'` 的 TaskFailed | 查阅 task-executor 测试 |
| Run 层 error 不被重包装 | 查阅 run-lifecycle 测试 |
| RunCompleted 仍正确触发 TaskCompleted | 回归测试 |
| 循环异常中止路径的 error 透传 | 查阅 task-executor 测试 |

- [ ] **Step 4：Phase 1 完成标记**

确认 commit 历史包含 1.1 和 1.2 两次 commit，工作树干净。

---

# Phase 2：取消事件定义

**目标**：补齐 `GraphRunCancelled` 事件类型，让 `graph-runner` catch 区分 AbortError，确保取消路径在三层聚合都有独立的终端事件。**此阶段完成后，即使没有外部取消命令触发，当前代码中 HITL 中断场景也能正确走取消语义链路。**

**依赖**：Phase 1 完成。

---

### Task 2.1：新增 GraphRunCancelled 事件类型

**Files:**
- Modify: `packages/shared/src/events/graph-run.ts`
- Modify: `packages/shared/src/index.ts`（如需导出）
- Test: `packages/shared/src/events/__tests__/graph-run.test.ts`（如无则新建）

- [ ] **Step 1：读现有 graph-run 事件定义**

Read: `packages/shared/src/events/graph-run.ts` 完整文件。

- [ ] **Step 2：新增类型定义（结构骨架）**

在 `graph-run.ts` 新增：

```ts
// 骨架，非完整实现
export interface GraphRunCancelledEvent {
  type: 'GraphRunCancelled'
  runId: string
  graphId: string
  graphVersion: number
  reason: 'abort'
  timestamp: number
}
```

并加入 `GraphRunDomainEvent` union。

- [ ] **Step 3：写类型 guard 测试（如有现有 guard 模式）**

```ts
it('GraphRunCancelled 加入 GraphRunDomainEvent union', () => {
  const ev: GraphRunCancelledEvent = {
    type: 'GraphRunCancelled',
    runId: 'r1',
    graphId: 'g1',
    graphVersion: 1,
    reason: 'abort',
    timestamp: Date.now(),
  }
  // 断言：ev 可赋值给 GraphRunDomainEvent
  const dom: GraphRunDomainEvent = ev
  expect(dom.type).toBe('GraphRunCancelled')
})
```

- [ ] **Step 4：运行测试**

```bash
pnpm --filter @tianji/shared test
```
Expected: PASS

- [ ] **Step 5：pnpm check**

```bash
pnpm check
```
Expected: 零 error / warning

- [ ] **Step 6：commit**

参考主题：`feat(shared): 新增 GraphRunCancelled 事件类型`

---

### Task 2.2：event-target 支持 GraphRunCancelled

**Files:**
- Modify: `packages/runtime/src/bus/event-target.ts`
- Test: `packages/runtime/src/bus/__tests__/event-target.test.ts`

- [ ] **Step 1：读现有 resolveTarget**

Read: `packages/runtime/src/bus/event-target.ts`。聚焦 switch case 列出所有 GraphRun* 事件的位置（spec 引用 28-34 行）。

- [ ] **Step 2：写失败测试**

```ts
it('resolveTarget(GraphRunCancelled) 返回 GraphRun 聚合', () => {
  const ev: GraphRunCancelledEvent = { type: 'GraphRunCancelled', runId: 'r1', ... }
  const target = resolveTarget(ev)
  expect(target.aggregateType).toBe('GraphRun')
  expect(target.aggregateId).toBe('r1')
})
```

- [ ] **Step 3：运行测试确认失败**

```bash
pnpm --filter @tianji/runtime test -- event-target
```
Expected: FAIL

- [ ] **Step 4：修改 event-target**

在 switch case 中加入 `GraphRunCancelled` 分支，映射到 `{aggregateType:'GraphRun', aggregateId:runId}`。

- [ ] **Step 5：运行测试确认通过**

```bash
pnpm --filter @tianji/runtime test -- event-target
```
Expected: PASS

- [ ] **Step 6：pnpm check + commit**

参考主题：`feat(runtime): event-target 支持 GraphRunCancelled 聚合解析`

---

### Task 2.3：graph-runner catch 区分 AbortError

**Files:**
- Modify: `packages/agent/src/orchestration/graph-runner.ts:131-139`（catch 块）
- Test: `packages/agent/src/orchestration/__tests__/graph-runner.test.ts`

**背景**：当前 catch 把 AbortError 和其他异常都发 `GraphRunFailed`。改造为：`error.name === 'AbortError' && signal.aborted` → 发 `GraphRunCancelled`；其他 → 发 `GraphRunFailed`。

- [ ] **Step 1：读 graph-runner 完整文件**

Read: `packages/agent/src/orchestration/graph-runner.ts` 全文，聚焦 runOrchestrationGraph 的 catch 块和 AbortSignal 处理。

- [ ] **Step 2：写失败测试（AbortError 路径）**

```ts
it('外部 AbortSignal 触发时发 GraphRunCancelled', async () => {
  const controller = new AbortController()
  const emit = vi.fn()
  const promise = runOrchestrationGraph({
    signal: controller.signal,
    emit,
    // ... 其他最小参数
  })
  controller.abort()
  await expect(promise).rejects.toThrow()
  // 断言 emit 被调用过 GraphRunCancelled，没被调用过 GraphRunFailed
  const types = emit.mock.calls.map(c => c[0].type)
  expect(types).toContain('GraphRunCancelled')
  expect(types).not.toContain('GraphRunFailed')
})
```

- [ ] **Step 3：写失败测试（非 Abort 异常路径）**

```ts
it('非 AbortError 异常发 GraphRunFailed，error 原样透传', async () => {
  const emit = vi.fn()
  // 构造会抛 ProviderError 的 invoke
  await expect(runOrchestrationGraph({ emit, ... })).rejects.toThrow()
  const failedCall = emit.mock.calls.find(c => c[0].type === 'GraphRunFailed')
  expect(failedCall[0].payload.error.name).toBe('ProviderError')
})
```

- [ ] **Step 4：运行测试确认失败**

```bash
pnpm --filter @tianji/agent test -- graph-runner
```
Expected: 两个新测试 FAIL

- [ ] **Step 5：改造 catch 块**

伪代码：

```ts
} catch (error) {
  const isAbort = (error as { name?: string }).name === 'AbortError' && signal.aborted
  if (isAbort) {
    emitGraphEvent({
      type: 'GraphRunCancelled',
      runId,
      graphId,
      graphVersion,
      reason: 'abort',
      timestamp: Date.now(),
    })
  } else {
    emitGraphEvent({
      type: 'GraphRunFailed',
      runId, graphId, graphVersion,
      error: { name: (error as Error).name, message: (error as Error).message },
      timestamp: Date.now(),
    })
  }
  throw error
}
```

- [ ] **Step 6：运行测试确认通过**

Expected: PASS

- [ ] **Step 7：pnpm check + commit**

参考主题：`feat(agent): graph-runner 区分 AbortError 发 GraphRunCancelled`

---

### Task 2.4：run-lifecycle 对取消路径发 RunCancelled

**Files:**
- Modify: `packages/runtime/src/runtime/run-lifecycle.ts`（catch 路径分支 / abort 识别）
- Test: `packages/runtime/src/__tests__/run-lifecycle.test.ts`

**背景**：graph-runner 抛出的 AbortError 冒泡到 run-lifecycle。当前代码已有 `handleRunCancellation`（spec 引用 226-230 行，reason='abort'），但需要确认它在 graph 抛 AbortError 时被正确调用。

- [ ] **Step 1：读 run-lifecycle 的取消分支**

Read: `packages/runtime/src/runtime/run-lifecycle.ts` 全文，聚焦 `handleRunCancellation` 和异常识别逻辑。

- [ ] **Step 2：写失败测试**

```ts
it('graph 因 AbortSignal 抛 AbortError 时，发 RunCancelled(reason=abort)，不发 RunFailed', async () => {
  const controller = new AbortController()
  const emit = vi.fn()
  // 构造 run-lifecycle 的 run，signal 接 controller
  const p = runWithLifecycle({ signal: controller.signal, emit, ... })
  controller.abort()
  await expect(p).rejects.toThrow()
  const types = emit.mock.calls.map(c => c[0].type)
  expect(types).toContain('RunCancelled')
  expect(types).not.toContain('RunFailed')
  const cancelled = emit.mock.calls.find(c => c[0].type === 'RunCancelled')[0]
  expect(cancelled.reason).toBe('abort')
})
```

- [ ] **Step 3：运行测试确认当前状态**

```bash
pnpm --filter @tianji/runtime test -- run-lifecycle
```

**可能两种情况**：
1. 测试 PASS（说明 run-lifecycle 现有代码已正确识别 AbortSignal）→ 跳到 Step 5
2. 测试 FAIL → 需要改动

- [ ] **Step 4：如需改动，修改 run-lifecycle**

改动思路：
- catch 块先检查 `signal.aborted`
- 如果是 abort，调用 `handleRunCancellation(reason='abort')`，不走 `handleRunFailure`
- 否则走现有 `handleRunFailure` 路径（Phase 1 已改为透传 error）

- [ ] **Step 5：运行测试确认通过**

Expected: PASS

- [ ] **Step 6：pnpm check + commit**

如果 Step 3 就已 PASS，此 Task 不产生代码 commit，只产生测试 commit（作为保护性测试）。参考主题：`test(runtime): 补充 run-lifecycle AbortSignal 取消路径测试`

---

### Task 2.5：task-executor 扩展分发加 RunCancelled → TaskCancelled

**Files:**
- Modify: `apps/node/src/task/task-executor.ts`（Phase 1 Task 1.2 的分发分支基础上扩展）
- Test: `apps/node/src/task/__tests__/task-executor.test.ts`

- [ ] **Step 1：写失败测试**

```ts
it('Run 取消时发 TaskCancelled', async () => {
  // 构造 fake runner，yield RunStarted + RunCancelled({reason:'abort'})
  // 执行 TaskExecutor.execute
  // 断言：emit 调用里最后一个 Task 终端是 TaskCancelled
})
```

- [ ] **Step 2：运行测试确认失败**

```bash
pnpm --filter @tianji/node test -- task-executor
```
Expected: FAIL

- [ ] **Step 3：在 task-executor 分发表加 RunCancelled 分支**

伪代码（延续 Phase 1 的结构）：

```ts
} else if (lastRunTerminalType === 'RunCancelled') {
  emitEvent({ type: 'TaskCancelled', taskId, timestamp: now() })
}
```

- [ ] **Step 4：运行测试确认通过**

Expected: PASS

- [ ] **Step 5：pnpm check + commit**

参考主题：`feat(node): task-executor 在 RunCancelled 时发 TaskCancelled`

---

### Task 2.6：Phase 2 回归验收

- [ ] **Step 1：回归所有改动 package 的测试**

```bash
pnpm --filter @tianji/shared test
pnpm --filter @tianji/runtime test
pnpm --filter @tianji/agent test
pnpm --filter @tianji/node test
```
Expected: 全部 PASS

- [ ] **Step 2：pnpm check 全量**

```bash
pnpm check
```
Expected: 零 error / warning

- [ ] **Step 3：验收标准**

| 标准 | 验证方法 |
|---|---|
| GraphRunCancelled 事件类型定义完整 | shared 测试 |
| graph-runner AbortError 路径发 GraphRunCancelled | agent 测试 |
| run-lifecycle 识别 abort 发 RunCancelled | runtime 测试 |
| task-executor 按 RunCancelled 分发 TaskCancelled | node 测试 |

---

# Phase 3：Cancel 命令通路

**目标**：打通"用户前端点取消 → Node 中止 task"的完整通路。

**依赖**：Phase 2 完成（取消事件链已齐全）。

---

### Task 3.1：Command 改为 discriminated union + TaskCancelPayload

**Files:**
- Modify: `packages/shared/src/command.ts`
- Test: `packages/shared/src/__tests__/command.test.ts`（如无则新建）

- [ ] **Step 1：读现有 Command 定义**

Read: `packages/shared/src/command.ts` 全文（spec 引用 42-52 行）。

- [ ] **Step 2：写失败测试**

```ts
it('Command 支持 task.cancel 子类型', () => {
  const cmd: Command = {
    commandId: 'c1',
    type: 'task.cancel',
    payload: { taskId: 't1', reason: 'user' },
    createdAt: Date.now(),
    // ... 其他字段
  }
  expect(cmd.type).toBe('task.cancel')
  if (cmd.type === 'task.cancel') {
    expect(cmd.payload.taskId).toBe('t1')
  }
})

it('discriminated union：不同 type 对应不同 payload 形状', () => {
  const runCmd: TaskRunCommand = {
    type: 'task.run',
    payload: { taskId: 't1', agentId: 'a1', goal: '...', sessionIds: [] },
    // ...
  }
  const cancelCmd: TaskCancelCommand = {
    type: 'task.cancel',
    payload: { taskId: 't1', reason: 'user' },
    // ...
  }
  // 两者都可赋值给 Command
  const cmds: Command[] = [runCmd, cancelCmd]
  expect(cmds).toHaveLength(2)
})
```

- [ ] **Step 3：运行测试确认失败**

```bash
pnpm --filter @tianji/shared test
```
Expected: 编译错误（TaskCancelCommand 未定义）

- [ ] **Step 4：改造 Command**

骨架：

```ts
export interface TaskCancelPayload {
  taskId: string
  reason: 'user'
}

export interface TaskRunCommand extends CommandBase {
  type: 'task.run'
  payload: TaskRunPayload
}

export interface TaskCancelCommand extends CommandBase {
  type: 'task.cancel'
  payload: TaskCancelPayload
}

export type Command = TaskRunCommand | TaskCancelCommand
```

其中 `CommandBase` 抽出 commandId/createdAt/nodeId 等共享字段。

- [ ] **Step 5：运行测试确认通过**

Expected: PASS

- [ ] **Step 6：修复 downstream 类型错误**

改 Command 为 union 后，下游所有使用 `command.payload.taskId` 的位置都可能报错（因为现在需要 narrow）。运行：

```bash
pnpm check
```

识别所有报错位置（predict 包括 `task-executor.ts:69` 的 `command.payload.taskId`、`controlplane` 的路由等）。**本 Task 只**补 `task.run` narrow（因为现有代码都假设是 run），让 pnpm check 通过。`task.cancel` 分支在 3.5 加。

- [ ] **Step 7：pnpm check + commit**

参考主题：`feat(shared): Command 改 discriminated union 支持 task.cancel`

---

### Task 3.2：PollCommandResponse 类型同步

**Files:**
- Modify: `apps/controlplane/src/routes/command-poll.ts:109-113`（返回类型）
- Test: `apps/controlplane/src/routes/__tests__/command-poll.test.ts`

- [ ] **Step 1：读现有 command-poll**

Read: `apps/controlplane/src/routes/command-poll.ts` 全文（spec 引用 26-107 行）。

- [ ] **Step 2：写失败测试**

```ts
it('command-poll 能返回 task.cancel 类型的命令', async () => {
  // 在 commands 表插入一行 type='task.cancel'
  // 发起 poll 请求
  // 断言：返回的 PollCommandResponse.type === 'task.cancel'
  // 断言：payload 字段符合 TaskCancelPayload
})
```

- [ ] **Step 3：运行测试确认失败**

```bash
pnpm --filter @tianji/controlplane test -- command-poll
```
Expected: FAIL 或类型错误

- [ ] **Step 4：改 PollCommandResponse 类型**

让 `PollCommandResponse` 沿用 shared 的 `Command` union；route 本身不过滤 type（SELECT 不按 type 筛选），直接序列化返回。

- [ ] **Step 5：运行测试确认通过**

Expected: PASS

- [ ] **Step 6：pnpm check + commit**

参考主题：`feat(controlplane): command-poll 支持 task.cancel 命令透传`

---

### Task 3.3：ActiveExecutorRegistry 实现

**Files:**
- Create: `apps/node/src/task/active-executor-registry.ts`
- Test: `apps/node/src/task/__tests__/active-executor-registry.test.ts`

- [ ] **Step 1：写失败测试清单**

```ts
describe('ActiveExecutorRegistry', () => {
  it('register 后可通过 taskId 路由 cancel', () => {
    const registry = new ActiveExecutorRegistry()
    const executor = { cancel: vi.fn() } as unknown as TaskExecutor
    registry.register('t1', executor)
    registry.cancel('t1')
    expect(executor.cancel).toHaveBeenCalledOnce()
  })

  it('unregister 后 cancel 抛错（Let it crash）', () => {
    const registry = new ActiveExecutorRegistry()
    const executor = { cancel: vi.fn() } as unknown as TaskExecutor
    registry.register('t1', executor)
    registry.unregister('t1')
    expect(() => registry.cancel('t1')).toThrow(/not found/i)
  })

  it('同一 taskId 重复 register 抛错', () => {
    const registry = new ActiveExecutorRegistry()
    const e1 = { cancel: vi.fn() } as unknown as TaskExecutor
    const e2 = { cancel: vi.fn() } as unknown as TaskExecutor
    registry.register('t1', e1)
    expect(() => registry.register('t1', e2)).toThrow(/already/i)
  })

  it('cancel 不存在的 taskId 抛错', () => {
    const registry = new ActiveExecutorRegistry()
    expect(() => registry.cancel('t1')).toThrow(/not found/i)
  })
})
```

- [ ] **Step 2：运行测试确认失败**

```bash
pnpm --filter @tianji/node test -- active-executor-registry
```
Expected: FAIL（文件不存在）

- [ ] **Step 3：实现 ActiveExecutorRegistry**

骨架：

```ts
export class ActiveExecutorRegistry {
  readonly #executors = new Map<string, TaskExecutor>()

  register(taskId: string, executor: TaskExecutor): void {
    if (this.#executors.has(taskId)) {
      throw new Error(`TaskExecutor already registered for taskId=${taskId}`)
    }
    this.#executors.set(taskId, executor)
  }

  unregister(taskId: string): void {
    this.#executors.delete(taskId)
  }

  cancel(taskId: string): void {
    const executor = this.#executors.get(taskId)
    if (executor === undefined) {
      throw new Error(`TaskExecutor not found for taskId=${taskId}`)
    }
    executor.cancel()
  }
}
```

- [ ] **Step 4：运行测试确认通过**

Expected: PASS

- [ ] **Step 5：pnpm check + commit**

参考主题：`feat(node): 新增 ActiveExecutorRegistry 管理活跃 task`

---

### Task 3.4：TaskExecutor 暴露 cancel 方法

**Files:**
- Modify: `apps/node/src/task/task-executor.ts`
- Test: `apps/node/src/task/__tests__/task-executor.test.ts`

- [ ] **Step 1：写失败测试**

```ts
it('TaskExecutor.cancel() 在 busy 状态下触发 runner.disconnect', async () => {
  const runner = { connect: vi.fn(), disconnect: vi.fn(), query: asyncGeneratorStub() }
  const executor = new TaskExecutor({ ... })
  const running = executor.execute(cmd)  // 进入 busy
  executor.cancel()
  // 断言 runner.disconnect 被调用
  // 清理：让 query 抛 AbortError 让 running 结束
  await running.catch(() => {})
  expect(runner.disconnect).toHaveBeenCalled()
})

it('TaskExecutor.cancel() 在 idle 状态下抛错（Let it crash）', () => {
  const executor = new TaskExecutor({ ... })
  expect(() => executor.cancel()).toThrow(/idle/i)
})

it('重复 cancel 幂等（第二次静默）', async () => {
  const runner = { connect: vi.fn(), disconnect: vi.fn(), query: asyncGeneratorStub() }
  const executor = new TaskExecutor({ ... })
  const running = executor.execute(cmd)
  executor.cancel()
  executor.cancel()  // 应静默，不重复调 disconnect
  expect(runner.disconnect).toHaveBeenCalledTimes(1)
  await running.catch(() => {})
})
```

- [ ] **Step 2：运行测试确认失败**

```bash
pnpm --filter @tianji/node test -- task-executor
```
Expected: FAIL（cancel 方法不存在）

- [ ] **Step 3：实现 TaskExecutor.cancel**

骨架（追加到 TaskExecutor 类）：

```ts
#currentRunner: IAgentRunner | null = null
#cancelled = false

// execute() 里把 runner 保存到 #currentRunner

cancel(): void {
  if (this.#executionState !== 'busy') {
    throw new Error('Cannot cancel: TaskExecutor is idle')
  }
  if (this.#cancelled) return  // 幂等
  this.#cancelled = true
  void this.#currentRunner?.disconnect()
}

// execute() finally 里清理 #cancelled 和 #currentRunner
```

- [ ] **Step 4：运行测试确认通过**

Expected: PASS

- [ ] **Step 5：pnpm check + commit**

参考主题：`feat(node): TaskExecutor 暴露 cancel 方法`

---

### Task 3.5：daemon 命令分发支持 task.cancel

**Files:**
- Modify: 命令消费路径（查 `apps/node/src/commands/run.ts` 或 `apps/node/src/daemon-entry.ts` 或 `apps/node/src/node-runtime/controlplane-runtime.ts`）
- Test: `apps/node/src/__tests__/daemon-e2e.test.ts` 或新建针对命令分发的单测

**前置**：执行者先读 spec 引用的 command 消费路径，确认分发点。

- [ ] **Step 1：定位命令消费分发点**

Grep: 搜索 `command.type === 'task.run'` 或等价位置，确认 dispatch 函数。Read 完整文件。

- [ ] **Step 2：写失败测试**

```ts
it('daemon 收到 task.cancel 命令时调用 ActiveExecutorRegistry.cancel', async () => {
  const registry = new ActiveExecutorRegistry()
  // 注入 fake executor
  registry.register('t1', fakeExecutor)
  const cmd: TaskCancelCommand = { type: 'task.cancel', payload: { taskId: 't1', reason: 'user' }, ... }
  dispatchCommand(cmd, { registry, ... })
  expect(fakeExecutor.cancel).toHaveBeenCalledOnce()
})

it('daemon 收到 task.cancel 但 registry 无对应 taskId 时抛错（Let it crash）', () => {
  const registry = new ActiveExecutorRegistry()
  const cmd: TaskCancelCommand = { type: 'task.cancel', payload: { taskId: 't-nonexistent', reason: 'user' }, ... }
  expect(() => dispatchCommand(cmd, { registry, ... })).toThrow(/not found/i)
})
```

- [ ] **Step 3：运行测试确认失败**

Expected: FAIL

- [ ] **Step 4：修改分发路径**

在命令消费位置加 switch case：

```ts
switch (command.type) {
  case 'task.run':
    // 现有逻辑：createExecutor + registry.register + execute + finally unregister
    break
  case 'task.cancel':
    registry.cancel(command.payload.taskId)
    break
  default:
    throw new Error(`Unknown command type: ${(command as { type: string }).type}`)
}
```

同时 `task.run` 路径要改造为：创建 TaskExecutor 后立即 `registry.register(taskId, executor)`，`execute()` 的 finally 块中 `registry.unregister(taskId)`。

- [ ] **Step 5：运行测试确认通过**

Expected: PASS

- [ ] **Step 6：pnpm check + commit**

参考主题：`feat(node): daemon 支持 task.cancel 命令分发到 ActiveExecutorRegistry`

---

### Task 3.6：TianjiAgent.cancelTask 实现

**Files:**
- Modify: `apps/controlplane/src/agents/tianji-agent.ts`
- Test: `apps/controlplane/src/agents/__tests__/tianji-agent.test.ts`

- [ ] **Step 1：读现有 TianjiAgent.run**

Read: `apps/controlplane/src/agents/tianji-agent.ts:93-114`（spec 引用的插入 commands 表逻辑）。

- [ ] **Step 2：写失败测试**

```ts
it('cancelTask 向 commands 表插入 task.cancel 命令，字段正确', async () => {
  const agent = new TianjiAgent({ ... })
  await agent.cancelTask('t1')
  const rows = db.query('SELECT * FROM commands WHERE type = ?').all('task.cancel')
  expect(rows).toHaveLength(1)
  expect(rows[0].payload).toMatchObject({ taskId: 't1', reason: 'user' })
  expect(rows[0].state).toBe('pending')
  expect(rows[0].node_id).toBeDefined()
})

it('cancelTask 能从 tasks 表反查 nodeId', async () => {
  // 预置：tasks 表有一行 taskId=t1, nodeId=n1
  await agent.cancelTask('t1')
  const row = db.query('SELECT node_id FROM commands WHERE payload LIKE ?').get('%t1%')
  expect(row.node_id).toBe('n1')
})

it('cancelTask 对不存在的 taskId 抛错', async () => {
  await expect(agent.cancelTask('t-nonexistent')).rejects.toThrow(/not found/i)
})
```

- [ ] **Step 3：运行测试确认失败**

```bash
pnpm --filter @tianji/controlplane test -- tianji-agent
```
Expected: FAIL（cancelTask 方法不存在）

- [ ] **Step 4：实现 cancelTask**

骨架：

```ts
async cancelTask(taskId: string): Promise<void> {
  const task = this.#db.query('SELECT node_id FROM tasks WHERE task_id = ?').get(taskId)
  if (task === undefined) {
    throw new Error(`Task not found: ${taskId}`)
  }
  this.#db.exec('INSERT INTO commands (command_id, node_id, type, payload, state, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId(), task.node_id, 'task.cancel', JSON.stringify({ taskId, reason: 'user' }), 'pending', Date.now()])
}
```

**注意**：如果现有 `tasks` 表 schema 没有 `node_id` 字段，需要补 schema（新 migration）。执行者先检查 schema，必要时新增 migration task。

- [ ] **Step 5：运行测试确认通过**

Expected: PASS

- [ ] **Step 6：pnpm check + commit**

参考主题：`feat(controlplane): TianjiAgent 新增 cancelTask 方法`

---

### Task 3.7：CP 路由接收 cancel 请求

**Files:**
- Modify: `apps/controlplane/src/routes/copilot.ts` 或新建路由文件
- Test: 对应 routes 测试目录

- [ ] **Step 1：读 copilot.ts 现状**

Read: `apps/controlplane/src/routes/copilot.ts` 全文（spec 引用 32-51 行）。确认 CopilotKit 是否通过特定 action 或 header 传递 cancel 意图。

- [ ] **Step 2：写失败测试**

```ts
it('POST /api/copilot/cancel 接收 taskId 后调用 TianjiAgent.cancelTask', async () => {
  const response = await request(app).post('/api/copilot/cancel').send({ taskId: 't1' })
  expect(response.status).toBe(202)
  // 断言 commands 表有新行
})

it('缺失 taskId 返回 400', async () => {
  const response = await request(app).post('/api/copilot/cancel').send({})
  expect(response.status).toBe(400)
})
```

> 路由路径和请求形式可能根据 CopilotKit SDK 实际约定调整；如 SDK 提供特定 action channel，改用对应形式。

- [ ] **Step 3：运行测试确认失败**

Expected: FAIL（路由不存在）

- [ ] **Step 4：实现路由**

骨架：

```ts
router.post('/api/copilot/cancel', async (req, res) => {
  const { taskId } = req.body
  if (typeof taskId !== 'string') {
    return res.status(400).json({ error: 'taskId required' })
  }
  const nodeId = req.headers['x-node-id']
  // ...构造 TianjiAgent 或直接调用全局 agent 实例
  await agent.cancelTask(taskId)
  res.status(202).end()
})
```

- [ ] **Step 5：运行测试确认通过**

Expected: PASS

- [ ] **Step 6：pnpm check + commit**

参考主题：`feat(controlplane): 新增 cancel 路由对接 TianjiAgent.cancelTask`

---

### Task 3.8：event-mapper 补 TaskCancelled 映射

**Files:**
- Modify: `apps/controlplane/src/agents/event-mapper.ts`（spec 引用 79-103, 335-338 行）
- Test: `apps/controlplane/src/agents/__tests__/event-mapper.test.ts`

- [ ] **Step 1：读 event-mapper 现状**

Read: `apps/controlplane/src/agents/event-mapper.ts` 全文。确认 TaskCancelled 现有映射（spec 引用 93-103 行）是否合适；确认 default 分支的兜底行为。

- [ ] **Step 2：写失败测试**

```ts
it('TaskCancelled 映射到 AG-UI RUN_FINISHED(reason=cancelled)', () => {
  const event: TaskCancelledEvent = { type: 'TaskCancelled', taskId: 't1', timestamp: 0 }
  const aguiEvents = mapDomainEventToAGUI(event, ctx)
  expect(aguiEvents.some(e => e.type === 'RUN_FINISHED')).toBe(true)
  // 具体 reason 字段按 AG-UI 协议定义
})
```

> 具体映射字段依 AG-UI 协议定义，执行者需查 AG-UI 最新规范或 CopilotKit 文档。

- [ ] **Step 3：运行测试确认当前状态**

如果 spec 引用的 93-103 行已有映射且符合预期 → 测试直接 PASS，只需加测试保护；否则按 Step 4 改造。

- [ ] **Step 4：如需改造，补充映射**

在 switch case 加 `TaskCancelled` → RUN_FINISHED 的 case。

- [ ] **Step 5：运行测试确认通过**

Expected: PASS

- [ ] **Step 6：pnpm check + commit**

参考主题：`feat(controlplane): event-mapper 补齐 TaskCancelled 到 AG-UI 映射`

---

### Task 3.9：端到端集成测试

**Files:**
- Modify: `apps/controlplane/src/__tests__/controlplane-node.e2e.test.ts`

- [ ] **Step 1：写 cancel e2e 测试**

```ts
it('用户发起 cancel → node 中止 → AG-UI 感知 cancelled', async () => {
  // 起 task（post /api/copilot）
  // 等 TaskStarted 事件到达 event_log
  // 发 cancel 请求（post /api/copilot/cancel {taskId}）
  // 等待事件链：GraphRunCancelled → RunCancelled → TaskCancelled
  // 断言 AG-UI 流里出现 RUN_FINISHED(cancelled)
  // 断言总延迟 < 3 秒
})

it('ProviderError 失败 → 前端感知', async () => {
  // 模拟 provider 返回 500 empty_stream
  // 起 task
  // 等 TaskFailed 到达，断言 error.code === 'ProviderError' 或 'PROVIDER_ERROR'
})
```

- [ ] **Step 2：运行集成测试**

```bash
pnpm --filter @tianji/controlplane test -- controlplane-node.e2e
```
Expected: PASS

- [ ] **Step 3：冒烟测试**

```bash
SMOKE_E2E=1 pnpm --filter @tianji/node test:smoke
```
Expected: PASS

- [ ] **Step 4：pnpm check + commit**

参考主题：`test(controlplane): 增补 cancel 和 provider-error 的端到端测试`

---

### Task 3.10：前端集成（如需）

**Files:**
- 可能涉及：CopilotKit provider 配置、取消按钮组件

- [ ] **Step 1：核查 CopilotKit SDK 能力**

查 CopilotKit 当前版本文档，确认是否有内置 cancel hook 或 action。

- [ ] **Step 2：如 SDK 有内置**

配置 provider，使之在用户点击内置取消按钮时 POST 到 Task 3.7 的 `/api/copilot/cancel` 路由。

- [ ] **Step 3：如 SDK 无内置**

自建最小取消按钮组件（前端代码位置需执行者定位）；按钮 onClick 调 `/api/copilot/cancel`。

- [ ] **Step 4：手测验证**

在本地环境启动前后端，起一个 task，点取消，观察：
- 前端 UI 是否收到 "任务已取消" 状态
- event_log 表里是否有完整事件链
- Node 日志里是否见到 task.cancel 命令处理

- [ ] **Step 5：commit（如有代码改动）**

参考主题：`feat(controlplane-client): 新增任务取消按钮对接 /api/copilot/cancel`

---

### Task 3.11：文档与 README 更新

**Files:**
- Modify: `apps/node/README.md`
- Modify: `apps/controlplane/README.md`
- Modify: `docs/development/09 - EVENT_BUS_DESIGN.md`

- [ ] **Step 1：更新 apps/node README**

新增章节：
- "活跃任务注册表"（ActiveExecutorRegistry）
- "取消任务"（TaskExecutor.cancel + 命令分发）

- [ ] **Step 2：更新 apps/controlplane README**

新增章节：
- "取消命令路由"（/api/copilot/cancel）
- "TianjiAgent.cancelTask"

- [ ] **Step 3：更新 docs/development/09 - EVENT_BUS_DESIGN.md**

补充：
- `GraphRunCancelled` 事件在 GraphRun 聚合层的位置
- 三条路径 × 三层聚合的终端事件矩阵
- 取消路径的命令下发 + 事件回传双向流示意图

- [ ] **Step 4：commit**

参考主题：`docs: 同步 task cancel 通路和事件对齐的设计文档`

---

### Task 3.12：Phase 3 最终回归验收

- [ ] **Step 1：全量测试**

```bash
pnpm test
```
Expected: 全部 PASS（含 controlplane、node、runtime、agent、shared）

- [ ] **Step 2：全量 pnpm check**

```bash
pnpm check
```
Expected: 零 error / warning

- [ ] **Step 3：端到端冒烟**

```bash
SMOKE_E2E=1 pnpm --filter @tianji/node test:smoke
```
Expected: PASS

- [ ] **Step 4：验收标准对照 spec §13**

| 标准 | 通过条件 |
|---|---|
| pnpm check 零错误 | ✓ |
| 所有单元测试通过 | ✓ |
| 所有集成测试通过 | ✓ |
| ProviderError 场景前端能看 code | Task 3.9 测试 |
| 前端取消 < 3 秒生效 | Task 3.9 测试 |
| 事件链完整性 | e2e 测试验证 |
| README 同步 | Task 3.11 |

---

## 自检清单（写完 plan 后的反思）

| 检查项 | 结论 |
|---|---|
| Spec §5.1 新增 GraphRunCancelled | Task 2.1 覆盖 ✓ |
| Spec §5.2 六条发射契约收紧 | Task 1.1 (error 透传) + 1.2 (分发) + 2.3 (AbortError 区分) + 2.5 (RunCancelled 联动) ✓ |
| Spec §5.3 因果链 | 由事件发射方向自然形成；Task 3.9 e2e 验证 ✓ |
| Spec §6.1 Command discriminated union | Task 3.1 ✓ |
| Spec §6.2 TaskCancelPayload | Task 3.1 ✓ |
| Spec §6.3 复用现有通路 | Task 3.2 ✓ |
| Spec §7.1 ActiveExecutorRegistry | Task 3.3 ✓ |
| Spec §7.2 TaskExecutor.cancel | Task 3.4 ✓ |
| Spec §7.3 命令分发 | Task 3.5 ✓ |
| Spec §7.4 for-await 分发 | Task 1.2 + 2.5 ✓ |
| Spec §8.1 TianjiAgent.cancelTask | Task 3.6 ✓ |
| Spec §8.2 HTTP 路由 | Task 3.7 ✓ |
| Spec §8.3 event-mapper 映射 | Task 3.8 ✓ |
| Spec §9 数据流 | Task 3.9 e2e ✓ |
| Spec §10 测试矩阵 | 全部 Task 的 TDD 步骤覆盖 ✓ |
| Spec §11 风险缓解 | Task 3.3 (重复 register 抛错) + 3.4 (idle cancel 抛错) + 3.5 (找不到 taskId 抛错) ✓ |
| Spec §12 分期 | Phase 1/2/3 对应 ✓ |
| Spec §13 验收 | Task 3.12 ✓ |

无未覆盖 spec 要求。
