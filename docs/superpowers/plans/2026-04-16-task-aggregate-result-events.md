# Task 聚合结果事件 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `TaskMessageStarted` / `TaskMessageDelta` / `TaskMessageCompleted` 三个 Task 聚合事件，由 daemon 侧 `TaskExecutor` 在消费 runner 的 `Message*` 事件时同步映射发出；controlplane 订阅 `aggregateId=taskId` 即可接收到流式 LLM 文本，不再需要推理 run/session 关系。

**Architecture:**
- `packages/shared` 新增事件接口与联合成员；`packages/runtime/bus/event-target` 扩展 `resolveTarget` 将其落到 `aggregateType=Task` + `aggregateId=event.taskId`。
- `apps/node/src/task/task-executor.ts` 在现有 `for await (const event of runner.query(...))` 循环中，收到 `MessageStarted/Delta/Completed` 时先 `emitEvent` 原事件（保留观测链），再额外 `emitEvent` 对应的 `TaskMessage*` 事件（展示链）。
- `apps/controlplane/src/agents/event-mapper.ts` 对 `TaskMessage*` 复用现有 `mapMessageDelta` / `mapMessageCompleted` 辅助函数映射到 AG-UI 的 `TEXT_MESSAGE_*` / `REASONING_*`。
- `packages/shared/event-diagnostics.ts` 扩展 `shouldLogEventDiagnostics` 排除 `TaskMessageDelta` 以避免刷屏。
- writer-rules 不变：`Task` 聚合默认要求 `processKind === 'node'`，新事件由 node 发射、符合规则。

**Tech Stack:** TypeScript strict、Vitest、`@ag-ui/client`、pnpm 工作区、现有 `@tianji/runtime` 的 `createRuntimeEventPipeline` / `resolveTarget` 装配链。

---

## 文件结构

| 文件路径 | 动作 | 责任 |
|---|---|---|
| `packages/shared/src/events/task.ts` | 修改 | 定义三个 `TaskMessage*Event` 接口；把它们加入 `TaskDomainEvent` 联合 |
| `packages/runtime/src/bus/event-target.ts` | 修改 | `resolveTarget` 的 `Task` 分支补三个新 `case`；保持 `never` 穷举 |
| `packages/runtime/src/bus/__tests__/event-target.test.ts` | 修改 | 新增 3 条单测覆盖三个新事件 |
| `packages/shared/src/event-diagnostics.ts` | 修改 | 诊断过滤扩展到 `TaskMessageDelta` |
| `apps/node/src/task/task-executor.ts` | 修改 | 新增 `emitTaskMessageMirror(event)` 私有助手；在 `for await` 循环中调用 |
| `apps/node/src/task/__tests__/task-executor.test.ts` | 修改 | 新增 3 条测试：`TaskMessageStarted` 镜像、`TaskMessageDelta` 镜像（含 thinking 通道）、`TaskMessageCompleted` 镜像；同时保留原 `Message*` 仍发射 |
| `apps/controlplane/src/agents/event-mapper.ts` | 修改 | `switch (env.type)` 新增三个 `case`，复用 `mapMessageDelta` / `mapMessageCompleted` |
| `apps/controlplane/src/agents/__tests__/event-mapper.test.ts` | 修改 | 新增 `describe('TaskMessage* 事件映射')` 覆盖三个事件 |

无新增文件。

---

## Task 1: `packages/shared` 新增三个 TaskMessage 事件类型

**目的：**
- 让 `TaskDomainEvent` 联合成员包含新事件类型；复用 `run.ts` 已有的 `AppMessage`、`MessageDeltaChannel`、`MessageDeltaPayload` 避免重复定义。

**Files:**
- Modify: `packages/shared/src/events/task.ts`

- [ ] **Step 1: 编辑 `packages/shared/src/events/task.ts`，在顶部 `import` 区加入类型依赖**

  在第 7 行（`import type { TianjiError } from '../errors.js'`）之后插入：

  ```ts
  import type { AppMessage } from '../message.js'
  import type { MessageDeltaChannel, MessageDeltaPayload } from './run.js'
  ```

- [ ] **Step 2: 在 `TaskObservationLostEvent` 定义（第 41-44 行）之后、`TaskDomainEvent` 联合（第 46 行）之前，插入三个新事件接口**

  ```ts
  export interface TaskMessageStartedEvent extends TaskFields {
    readonly type: 'TaskMessageStarted'
    readonly messageId: string
    readonly role: 'assistant'
  }

  export interface TaskMessageDeltaEvent extends TaskFields {
    readonly type: 'TaskMessageDelta'
    readonly messageId: string
    readonly sequence: number
    readonly channel: MessageDeltaChannel
    readonly payload: MessageDeltaPayload
  }

  export interface TaskMessageCompletedEvent extends TaskFields {
    readonly type: 'TaskMessageCompleted'
    readonly messageId: string
    readonly message: AppMessage
  }
  ```

- [ ] **Step 3: 把三个新事件补进 `TaskDomainEvent` 联合**

  原（第 46-53 行）：
  ```ts
  export type TaskDomainEvent =
    | TaskStartedEvent
    | TaskWaitingEvent
    | TaskSessionAttachedEvent
    | TaskCompletedEvent
    | TaskFailedEvent
    | TaskCancelledEvent
    | TaskObservationLostEvent
  ```

  改为：
  ```ts
  export type TaskDomainEvent =
    | TaskStartedEvent
    | TaskWaitingEvent
    | TaskSessionAttachedEvent
    | TaskCompletedEvent
    | TaskFailedEvent
    | TaskCancelledEvent
    | TaskObservationLostEvent
    | TaskMessageStartedEvent
    | TaskMessageDeltaEvent
    | TaskMessageCompletedEvent
  ```

- [ ] **Step 4: 在仓库根目录运行 `pnpm --filter @tianji/shared build` 验证类型能编译**

  Expected: 编译成功；若失败请根据报错修正 import 路径。

- [ ] **Step 5: 提交**

  ```bash
  git add packages/shared/src/events/task.ts
  git commit -m "feat(shared): 新增 TaskMessageStarted/Delta/Completed 事件类型"
  ```

---

## Task 2: `resolveTarget` 扩展 Task 聚合事件目标

**目的：**
- 让新事件穿过 runtime event pipeline 后，envelope 的 `aggregateType` 为 `Task`、`aggregateId` 为 `taskId`，这样 TianjiAgent 的 `aggregateId=taskId` 订阅就能收到。

**Files:**
- Modify: `packages/runtime/src/bus/event-target.ts`
- Modify: `packages/runtime/src/bus/__tests__/event-target.test.ts`

- [ ] **Step 1: 先写失败测试** — 在 `packages/runtime/src/bus/__tests__/event-target.test.ts` 的 `describe('resolveTarget', () => {` 块末尾（紧挨最后一个 `}` 之前，第 68 行附近）插入三条用例

  ```ts
    it('Task 聚合：TaskMessageStarted → aggregateType=Task, aggregateId=taskId', () => {
      const event: DomainEvent = {
        type: 'TaskMessageStarted',
        taskId: 'task_1',
        messageId: 'msg_1',
        role: 'assistant',
        timestamp: 0,
      }
      const target = resolveTarget(event)
      expect(target.aggregateType).toBe('Task')
      expect(target.aggregateId).toBe('task_1')
    })

    it('Task 聚合：TaskMessageDelta → aggregateType=Task, aggregateId=taskId', () => {
      const event: DomainEvent = {
        type: 'TaskMessageDelta',
        taskId: 'task_1',
        messageId: 'msg_1',
        sequence: 1,
        channel: 'text',
        payload: { content: 'hello' },
        timestamp: 0,
      }
      const target = resolveTarget(event)
      expect(target.aggregateType).toBe('Task')
      expect(target.aggregateId).toBe('task_1')
    })

    it('Task 聚合：TaskMessageCompleted → aggregateType=Task, aggregateId=taskId', () => {
      const event: DomainEvent = {
        type: 'TaskMessageCompleted',
        taskId: 'task_1',
        messageId: 'msg_1',
        message: {
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          createdAt: 0,
        },
        timestamp: 0,
      }
      const target = resolveTarget(event)
      expect(target.aggregateType).toBe('Task')
      expect(target.aggregateId).toBe('task_1')
    })
  ```

- [ ] **Step 2: 运行测试验证 3 条新用例失败**

  在 `packages/runtime` 目录执行：
  ```bash
  pnpm --filter @tianji/runtime test -- --run bus/__tests__/event-target.test.ts
  ```
  Expected: TypeScript 编译错误（`resolveTarget` 的 switch 未覆盖新类型 → `never` 分支检查触发）或运行时 `unknown event` 抛错。

- [ ] **Step 3: 修改 `packages/runtime/src/bus/event-target.ts`，在 `Task` 分支补三个 case**

  找到第 48-55 行：
  ```ts
      case 'TaskStarted':
      case 'TaskWaiting':
      case 'TaskSessionAttached':
      case 'TaskCompleted':
      case 'TaskFailed':
      case 'TaskCancelled':
      case 'TaskObservationLost':
        return { aggregateType: 'Task', aggregateId: event.taskId }
  ```

  改为：
  ```ts
      case 'TaskStarted':
      case 'TaskWaiting':
      case 'TaskSessionAttached':
      case 'TaskCompleted':
      case 'TaskFailed':
      case 'TaskCancelled':
      case 'TaskObservationLost':
      case 'TaskMessageStarted':
      case 'TaskMessageDelta':
      case 'TaskMessageCompleted':
        return { aggregateType: 'Task', aggregateId: event.taskId }
  ```

- [ ] **Step 4: 再次运行测试，确认 3 条用例通过**

  ```bash
  pnpm --filter @tianji/runtime test -- --run bus/__tests__/event-target.test.ts
  ```
  Expected: 全部用例 PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add packages/runtime/src/bus/event-target.ts packages/runtime/src/bus/__tests__/event-target.test.ts
  git commit -m "feat(runtime): resolveTarget 覆盖 TaskMessage* 事件 → Task 聚合"
  ```

---

## Task 3: `event-diagnostics` 过滤 `TaskMessageDelta` 日志

**目的：**
- 现状过滤了 `MessageDelta` 防日志刷屏；新增 `TaskMessageDelta` 是展示链上的镜像，数量同量级，必须同步过滤。

**Files:**
- Modify: `packages/shared/src/event-diagnostics.ts`

- [ ] **Step 1: 编辑 `packages/shared/src/event-diagnostics.ts`**

  找到第 6-8 行：
  ```ts
  export function shouldLogEventDiagnostics(env: DomainEventEnvelope): boolean {
    return env.type !== 'MessageDelta'
  }
  ```

  改为：
  ```ts
  export function shouldLogEventDiagnostics(env: DomainEventEnvelope): boolean {
    return env.type !== 'MessageDelta' && env.type !== 'TaskMessageDelta'
  }
  ```

- [ ] **Step 2: 提交**

  ```bash
  git add packages/shared/src/event-diagnostics.ts
  git commit -m "chore(shared): 诊断日志过滤新增 TaskMessageDelta，避免刷屏"
  ```

---

## Task 4: `TaskExecutor` 镜像 run 级 Message 为 task 级 TaskMessage

**目的：**
- 当 runner 产出 `MessageStarted/MessageDelta/MessageCompleted` 时，先原样发射（保留观测），紧接着发射对应的 `TaskMessage*` 事件（用于展示）。
- `TaskMessage*` 必须携带与对应 `Message*` 相同的 `messageId`，以便前端 AG-UI 稳定配对。
- 仅镜像 `role === 'assistant'` 的 `MessageStarted/MessageCompleted`；`MessageDelta` 无 role 字段但按照 ACP 路径只会是 assistant 流（agent_message_chunk / agent_thought_chunk），直接镜像。

**Files:**
- Modify: `apps/node/src/task/task-executor.ts`
- Modify: `apps/node/src/task/__tests__/task-executor.test.ts`

- [ ] **Step 1: 先写失败测试** — 打开 `apps/node/src/task/__tests__/task-executor.test.ts`，在 `describe('TaskExecutorConfig', () => {` 块内最后一个 `it(...)` 之后、`})` 闭合之前追加 3 个用例

  ```ts
    it('mirrors MessageStarted to TaskMessageStarted with same messageId and role=assistant', async () => {
      const module = await import('../task-executor.js')
      const emitEvent = vi.fn()
      const runId = 'run-mirror' as never
      const now = Date.now()
      const taskId = createTaskId('task-mirror-1')

      const executor = new module.TaskExecutor(
        makeConfig({
          emitEvent,
          createRunner: async () => ({
            agentId: 'default',
            connect: async () => undefined,
            disconnect: async () => undefined,
            async *query() {
              yield {
                type: 'RunStarted',
                runId,
                sessionId: 'session-mirror' as never,
                triggerType: 'new',
                timestamp: now,
              }
              yield {
                type: 'MessageStarted',
                runId,
                messageId: 'msg-mirror-1',
                message: {
                  id: 'msg-mirror-1',
                  role: 'assistant',
                  content: [],
                  createdAt: now,
                },
                timestamp: now,
              }
              yield {
                type: 'RunCompleted',
                runId,
                sessionId: 'session-mirror' as never,
                triggerType: 'new',
                timestamp: now,
              }
            },
          }),
        })
      )

      await executor.execute(createCommand(taskId, 'mirror started'))

      const events = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e)
      const runLevel = events.find((e) => e.type === 'MessageStarted')
      const taskLevel = events.find((e) => e.type === 'TaskMessageStarted')

      expect(runLevel).toBeDefined()
      expect(taskLevel).toBeDefined()
      expect((taskLevel as Extract<DomainEvent, { type: 'TaskMessageStarted' }>).taskId).toBe(
        String(taskId)
      )
      expect((taskLevel as Extract<DomainEvent, { type: 'TaskMessageStarted' }>).messageId).toBe(
        'msg-mirror-1'
      )
      expect((taskLevel as Extract<DomainEvent, { type: 'TaskMessageStarted' }>).role).toBe(
        'assistant'
      )

      // task 级事件必须紧跟在 run 级事件之后
      const runIdx = events.indexOf(runLevel as DomainEvent)
      const taskIdx = events.indexOf(taskLevel as DomainEvent)
      expect(taskIdx).toBe(runIdx + 1)
    })

    it('mirrors MessageDelta to TaskMessageDelta preserving channel/sequence/payload', async () => {
      const module = await import('../task-executor.js')
      const emitEvent = vi.fn()
      const runId = 'run-mirror-delta' as never
      const now = Date.now()
      const taskId = createTaskId('task-mirror-2')

      const executor = new module.TaskExecutor(
        makeConfig({
          emitEvent,
          createRunner: async () => ({
            agentId: 'default',
            connect: async () => undefined,
            disconnect: async () => undefined,
            async *query() {
              yield {
                type: 'RunStarted',
                runId,
                sessionId: 'session-mirror-2' as never,
                triggerType: 'new',
                timestamp: now,
              }
              yield {
                type: 'MessageDelta',
                runId,
                messageId: 'msg-d-1',
                sequence: 7,
                channel: 'thinking',
                payload: { content: 'pondering…' },
                timestamp: now,
              }
              yield {
                type: 'RunCompleted',
                runId,
                sessionId: 'session-mirror-2' as never,
                triggerType: 'new',
                timestamp: now,
              }
            },
          }),
        })
      )

      await executor.execute(createCommand(taskId, 'mirror delta'))

      const events = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e)
      const taskDelta = events.find((e) => e.type === 'TaskMessageDelta') as
        | Extract<DomainEvent, { type: 'TaskMessageDelta' }>
        | undefined

      expect(taskDelta).toBeDefined()
      expect(taskDelta?.taskId).toBe(String(taskId))
      expect(taskDelta?.messageId).toBe('msg-d-1')
      expect(taskDelta?.channel).toBe('thinking')
      expect(taskDelta?.sequence).toBe(7)
      expect(taskDelta?.payload.content).toBe('pondering…')
    })

    it('mirrors MessageCompleted to TaskMessageCompleted with full message payload', async () => {
      const module = await import('../task-executor.js')
      const emitEvent = vi.fn()
      const runId = 'run-mirror-complete' as never
      const now = Date.now()
      const taskId = createTaskId('task-mirror-3')
      const finalMessage = {
        id: 'msg-final',
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'final answer' }],
        createdAt: now,
      }

      const executor = new module.TaskExecutor(
        makeConfig({
          emitEvent,
          createRunner: async () => ({
            agentId: 'default',
            connect: async () => undefined,
            disconnect: async () => undefined,
            async *query() {
              yield {
                type: 'RunStarted',
                runId,
                sessionId: 'session-mirror-3' as never,
                triggerType: 'new',
                timestamp: now,
              }
              yield {
                type: 'MessageCompleted',
                runId,
                messageId: 'msg-final',
                message: finalMessage,
                timestamp: now,
              }
              yield {
                type: 'RunCompleted',
                runId,
                sessionId: 'session-mirror-3' as never,
                triggerType: 'new',
                timestamp: now,
              }
            },
          }),
        })
      )

      await executor.execute(createCommand(taskId, 'mirror completed'))

      const events = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e)
      const taskCompleted = events.find((e) => e.type === 'TaskMessageCompleted') as
        | Extract<DomainEvent, { type: 'TaskMessageCompleted' }>
        | undefined

      expect(taskCompleted).toBeDefined()
      expect(taskCompleted?.taskId).toBe(String(taskId))
      expect(taskCompleted?.messageId).toBe('msg-final')
      expect(taskCompleted?.message).toEqual(finalMessage)

      // 事件序列顺序：MessageCompleted → TaskMessageCompleted
      const order = events.map((e) => e.type)
      const runIdx = order.indexOf('MessageCompleted')
      const taskIdx = order.indexOf('TaskMessageCompleted')
      expect(taskIdx).toBeGreaterThan(runIdx)
    })
  ```

- [ ] **Step 2: 运行测试验证失败**

  ```bash
  cd apps/node && pnpm test -- --run src/task/__tests__/task-executor.test.ts
  ```
  Expected: 3 条新用例 FAIL（`TaskMessageStarted`/`TaskMessageDelta`/`TaskMessageCompleted` 未被 emitEvent 发射）。

- [ ] **Step 3: 修改 `apps/node/src/task/task-executor.ts`，在 `for await` 循环内追加镜像逻辑**

  找到第 104-115 行：
  ```ts
          for await (const event of runner.query(command.payload.goal)) {
            turn = await handleEvent(this.#config.logger, this.#scope, taskId, turn, event)
            if (
              event.type === 'RunCompleted' ||
              event.type === 'RunFailed' ||
              event.type === 'RunCancelled'
            ) {
              sawTerminalRunEvent = true
            }

            this.#config.emitEvent(event)
          }
  ```

  改为：
  ```ts
          for await (const event of runner.query(command.payload.goal)) {
            turn = await handleEvent(this.#config.logger, this.#scope, taskId, turn, event)
            if (
              event.type === 'RunCompleted' ||
              event.type === 'RunFailed' ||
              event.type === 'RunCancelled'
            ) {
              sawTerminalRunEvent = true
            }

            this.#config.emitEvent(event)

            const mirrored = mirrorRunMessageToTaskMessage(taskId, event, now())
            if (mirrored !== null) {
              this.#config.emitEvent(mirrored)
            }
          }
  ```

- [ ] **Step 4: 在同一文件末尾（紧跟 `handleEvent` 函数之后）追加 `mirrorRunMessageToTaskMessage` 纯函数**

  同时把 `TaskMessageStartedEvent` / `TaskMessageDeltaEvent` / `TaskMessageCompletedEvent` 加进顶部 `import type { ... } from '@tianji/shared'` 的导入清单。

  最终新增函数：
  ```ts
  /**
   * 将 run 级 Message* 事件镜像为 task 级 TaskMessage* 事件。
   * run 级原事件保留给 observability / 审计；task 级镜像用于 controlplane 展示。
   *
   * 只镜像 assistant 消息：`MessageDelta` 在当前 ACP 协议下仅由 agent_message_chunk /
   * agent_thought_chunk 产生（见 event-adapter），语义天然是 assistant。
   *
   * @param taskId - 任务 ID，用作 task 级事件的 aggregateId
   * @param event  - runner 产出的裸领域事件
   * @param timestamp - 镜像事件发射时间
   * @returns 对应的 TaskMessage* 事件；非消息事件返回 null
   */
  function mirrorRunMessageToTaskMessage(
    taskId: string,
    event: DomainEvent,
    timestamp: number
  ): TaskMessageStartedEvent | TaskMessageDeltaEvent | TaskMessageCompletedEvent | null {
    if (event.type === 'MessageStarted') {
      if (event.message.role !== 'assistant') return null
      return {
        type: 'TaskMessageStarted',
        taskId,
        messageId: event.messageId,
        role: 'assistant',
        timestamp,
      }
    }

    if (event.type === 'MessageDelta') {
      return {
        type: 'TaskMessageDelta',
        taskId,
        messageId: event.messageId,
        sequence: event.sequence,
        channel: event.channel,
        payload: event.payload,
        timestamp,
      }
    }

    if (event.type === 'MessageCompleted') {
      if (event.message.role !== 'assistant') return null
      return {
        type: 'TaskMessageCompleted',
        taskId,
        messageId: event.messageId,
        message: event.message,
        timestamp,
      }
    }

    return null
  }
  ```

  顶部 import 修改（约第 11-19 行）：
  ```ts
  import type {
    Command,
    DomainEvent,
    MessageCompletedEvent,
    NodeExecutionState,
    NodeId,
    TaskMessageCompletedEvent,
    TaskMessageDeltaEvent,
    TaskMessageStartedEvent,
    ToolCompletedEvent,
    ToolFailedEvent,
  } from '@tianji/shared'
  ```

- [ ] **Step 5: 再次运行测试**

  ```bash
  cd apps/node && pnpm test -- --run src/task/__tests__/task-executor.test.ts
  ```
  Expected: 全部用例 PASS（包括 3 条新增 + 原有所有用例）。

- [ ] **Step 6: 运行 `pnpm check` 确认无类型/Lint 错误**

  在仓库根目录执行：
  ```bash
  pnpm check
  ```
  Expected: 退出码 0，无 error/warning/info。若失败必须修复再继续。

- [ ] **Step 7: 提交**

  ```bash
  git add apps/node/src/task/task-executor.ts apps/node/src/task/__tests__/task-executor.test.ts
  git commit -m "feat(node): TaskExecutor 将 Message* 镜像为 TaskMessage* 展示事件"
  ```

---

## Task 5: `event-mapper` 映射 TaskMessage* 到 AG-UI

**目的：**
- controlplane 的 TianjiAgent 按 `aggregateId=taskId` 订阅，只会收到 Task 聚合事件。新增 `TaskMessage*` 事件必须被映射为 AG-UI 的 `TEXT_MESSAGE_*` / `REASONING_*` 事件，复用已有 `mapMessageDelta` / `mapMessageCompleted` 辅助函数，保持 thinking 通道语义一致。
- 保留现有 `MessageStarted/MessageDelta/MessageCompleted` 的 Run 级映射分支不动（第一阶段兼容策略，见 spec §10）。

**Files:**
- Modify: `apps/controlplane/src/agents/event-mapper.ts`
- Modify: `apps/controlplane/src/agents/__tests__/event-mapper.test.ts`

- [ ] **Step 1: 先写失败测试** — 在 `apps/controlplane/src/agents/__tests__/event-mapper.test.ts` 末尾追加新 `describe` 块

  ```ts
  // ============================================================================
  // TaskMessage* 事件映射
  // ============================================================================

  describe('TaskMessage* 事件映射', () => {
    it('TaskMessageStarted → TEXT_MESSAGE_START，role=assistant', () => {
      const result = mapToAgUi(
        envelope({
          type: 'TaskMessageStarted',
          taskId: 'task-001',
          messageId: 'msg-1',
          role: 'assistant',
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.TEXT_MESSAGE_START)
      expect((result[0] as { messageId: string }).messageId).toBe('msg-1')
      expect((result[0] as { role: string }).role).toBe('assistant')
    })

    it('TaskMessageDelta 在 text 通道下 → TEXT_MESSAGE_CONTENT', () => {
      const result = mapToAgUi(
        envelope({
          type: 'TaskMessageDelta',
          taskId: 'task-001',
          messageId: 'msg-1',
          sequence: 1,
          channel: 'text',
          payload: { content: 'hello' },
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.TEXT_MESSAGE_CONTENT)
      expect((result[0] as { delta: string }).delta).toBe('hello')
    })

    it('TaskMessageDelta 在 thinking 通道下首次触发 REASONING_START/REASONING_MESSAGE_START/REASONING_MESSAGE_CONTENT', () => {
      const ctx = freshCtx()
      const result = mapToAgUi(
        envelope({
          type: 'TaskMessageDelta',
          taskId: 'task-001',
          messageId: 'msg-1',
          sequence: 1,
          channel: 'thinking',
          payload: { content: 'step-1' },
          timestamp: 1000,
        }),
        ctx
      )
      expect(result.map((e) => e.type)).toEqual([
        EventType.REASONING_START,
        EventType.REASONING_MESSAGE_START,
        EventType.REASONING_MESSAGE_CONTENT,
      ])
      expect(ctx.inThinking).toBe(true)
    })

    it('TaskMessageCompleted 在 thinking 中先发 REASONING_MESSAGE_END+REASONING_END，再发 TEXT_MESSAGE_END', () => {
      const ctx: EventMapperContext = { inThinking: true, taskId: 'task-001' }
      const result = mapToAgUi(
        envelope({
          type: 'TaskMessageCompleted',
          taskId: 'task-001',
          messageId: 'msg-1',
          message: {
            id: 'msg-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            createdAt: 1000,
          },
          timestamp: 1000,
        }),
        ctx
      )
      expect(result.map((e) => e.type)).toEqual([
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
        EventType.TEXT_MESSAGE_END,
      ])
      expect(ctx.inThinking).toBe(false)
    })

    it('TaskMessageCompleted 非 thinking 状态下只发 TEXT_MESSAGE_END', () => {
      const result = mapToAgUi(
        envelope({
          type: 'TaskMessageCompleted',
          taskId: 'task-001',
          messageId: 'msg-1',
          message: {
            id: 'msg-1',
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            createdAt: 1000,
          },
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.TEXT_MESSAGE_END)
    })
  })
  ```

- [ ] **Step 2: 运行测试验证失败**

  ```bash
  cd apps/controlplane && pnpm test -- --run src/agents/__tests__/event-mapper.test.ts
  ```
  Expected: 5 条新用例 FAIL（`mapToAgUi` 对 `TaskMessage*` 落到 `default` 分支返回 `[]`）。

- [ ] **Step 3: 修改 `apps/controlplane/src/agents/event-mapper.ts`**

  在第 143 行（`case 'MessageCompleted'` 块的闭合大括号之后、`// ── Run 聚合：工具` 注释之前）插入新的 case 块：

  ```ts
      // ── Task 聚合：消息（展示链） ───────────────────────────────────────────
      case 'TaskMessageStarted': {
        const p = env.payload as { messageId: string }
        return [
          ev({
            type: EventType.TEXT_MESSAGE_START,
            messageId: p.messageId,
            role: 'assistant',
          }),
        ]
      }

      case 'TaskMessageDelta': {
        const p = env.payload as {
          messageId: string
          channel: string
          payload: { content: string }
        }
        return mapMessageDelta(p.messageId, p.channel, p.payload.content, ctx)
      }

      case 'TaskMessageCompleted': {
        const p = env.payload as { messageId: string }
        return mapMessageCompleted(p.messageId, ctx)
      }
  ```

- [ ] **Step 4: 再次运行测试**

  ```bash
  cd apps/controlplane && pnpm test -- --run src/agents/__tests__/event-mapper.test.ts
  ```
  Expected: 全部用例 PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add apps/controlplane/src/agents/event-mapper.ts apps/controlplane/src/agents/__tests__/event-mapper.test.ts
  git commit -m "feat(controlplane): event-mapper 支持 TaskMessage* → AG-UI TEXT/REASONING"
  ```

---

## Task 6: 全量回归与联调

**目的：**
- 验证三个包测试全绿，无编译/Lint 告警。
- 验证 shared 事件联合 `DomainEvent['type']` 的扩展未破坏其它消费者（例如 `isTaskEvent` 守卫、forwarder 的 envelope 归属判断、ingest writer-rules）。

**Files:** 无新增；全部为运行校验。

- [ ] **Step 1: 从仓库根目录运行 `pnpm check`**

  ```bash
  pnpm check
  ```
  Expected: 退出码 0，整份输出无 error/warning/info。若出现任何问题必须在本任务内修复，再继续。

- [ ] **Step 2: 跑受影响包的测试**

  ```bash
  pnpm --filter @tianji/shared test
  pnpm --filter @tianji/runtime test
  pnpm --filter @tianji/node test
  pnpm --filter @tianji/controlplane test
  ```
  Expected: 四个包全部 PASS。

- [ ] **Step 3: 冒烟测试（SMOKE_E2E=1）**

  若本地环境已按 `.env.test` 配置好 LLM 供应商：
  ```bash
  SMOKE_E2E=1 pnpm --filter @tianji/node test:smoke
  ```
  Expected: PASS 或（无 LLM 供应商时）按现有 skip 规则跳过。

  若因环境问题无法运行，必须在最终回复里显式声明"未跑冒烟，仅跑单测"。

- [ ] **Step 4: 无新提交则跳过；若上述步骤发现修复项，按修复内容提交新 commit**

  示例：
  ```bash
  git add <修复的文件>
  git commit -m "fix: <具体修复说明>"
  ```

---

## Self-Review 清单

- **Spec 覆盖：**
  - §四新增事件定义 → Task 1 全部覆盖
  - §七发射点（TaskExecutor） → Task 4
  - §八映射规则（assistant-only、sequence/channel/payload 保留） → Task 4 的 `mirrorRunMessageToTaskMessage`
  - §九 controlplane 消费 → Task 5
  - §十第一阶段兼容策略（保留 Run 级映射） → Task 5 未删旧分支
  - §十一测试要求 → Task 2 / 4 / 5 覆盖 shared/node/controlplane 三层单测；冒烟测试在 Task 6
  - §十二风险（thinking 通道、多消息任务） → Task 4 镜像保留 `messageId`，thinking 通道直通；多消息场景由 `messageId` 独立保证
- **无占位符：** 所有代码块均为可直接粘贴的完整实现。
- **类型一致：** 三处使用 `TaskMessageStartedEvent / TaskMessageDeltaEvent / TaskMessageCompletedEvent` 名称；`channel` 统一 `MessageDeltaChannel`；`payload` 统一 `MessageDeltaPayload`。
- **命名：** `mirrorRunMessageToTaskMessage` 唯一在 Task 4 中定义与使用。
