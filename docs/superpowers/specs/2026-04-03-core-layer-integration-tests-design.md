# Agent + Runtime 核心层集成测试设计

## 目标

为项目引擎层（`packages/runtime` + `packages/agent`）建立系统化的集成测试套件，覆盖 session 管理、工具执行、错误恢复、checkpoint 恢复、快照一致性等核心场景。

## 设计决策

| 决策项 | 结论 |
|--------|------|
| 模型替身 | 保持 `FakeListChatModel`（进程内），不引入 Mock HTTP 服务器 |
| 基础设施风格 | 增强现有 `runtime-test-utils.ts`，扁平函数式，不引入 TestRuntime 类 |
| 测试目录 | 新建 `__tests__/suite/` 子目录，按场景分文件 |
| 并发策略 | 不在 runtime 层加同 session 互斥，上层保证每个 agent 独立 session |

## 测试基础设施

### 增强 `packages/runtime/src/__tests__/helpers/runtime-test-utils.ts`

新增以下工具函数：

```typescript
/**
 * 快速构造 RuntimeToolDefinition。
 * @param name - 工具名
 * @param opts.sideEffect - 副作用级别，默认 'none'
 * @param opts.result - execute 返回值，默认 'ok'
 * @param opts.error - 若提供则 execute 抛出此错误
 * @param opts.delayMs - execute 前等待的毫秒数，用于模拟慢工具
 */
createMockTool(name: string, opts?: MockToolOptions): RuntimeToolDefinition

/**
 * 批量注册工具并返回 ToolCatalog。
 */
createToolRegistry(...tools: RuntimeToolDefinition[]): ToolCatalog

/**
 * 顺序执行多轮 runTurn，返回每轮的事件集合。
 * 每轮等待 run 完成后再发起下一轮。
 */
driveMultiTurn(
  runtime: SessionRuntime,
  sessionId: SessionId,
  prompts: Array<{ id: string; text: string }>,
  options?: { systemPrompt?: string }
): Promise<Array<{ runId: RunId; events: RuntimeEvent[] }>>

/**
 * 等待事件流中出现特定类型的事件，超时报错。
 */
waitForEvent(
  runtime: SessionRuntime,
  runId: RunId,
  eventType: RuntimeEvent['type'],
  timeoutMs?: number
): Promise<RuntimeEvent>

/**
 * 封装 FakeListChatModel 创建。
 */
createFakeModel(responses: string[]): FakeListChatModel

/**
 * 断言事件序列包含 run.completed 且不含 run.failed。
 */
assertRunCompleted(events: RuntimeEvent[]): void

/**
 * 断言事件序列以 run.failed 结束。
 */
assertRunFailed(events: RuntimeEvent[], errorPattern?: RegExp): void

/**
 * 断言特定工具被调用并完成。
 */
assertToolCalled(events: RuntimeEvent[], toolName: string): void

/**
 * 断言特定工具调用失败。
 */
assertToolFailed(events: RuntimeEvent[], toolName: string): void
```

### Checkpoint/Interrupt Mock 能力

`FakeListChatModel` 本身不支持 interrupt。为测试 checkpoint 恢复场景，需要一个能触发 deepagents interrupt 的 mock 机制。

策略：构造一个注册了 `interruptOn` 配置的工具，当模型调用该工具时 deepagents 框架会触发 interrupt。测试流程：

1. 注册一个名为 `require_approval` 的工具
2. 配置 `deepagents.interruptOn: { require_approval: true }`
3. 配置 `deepagents.checkpointer: true`（启用 MemorySaver）
4. FakeListChatModel 返回包含该工具调用的响应
5. runtime 进入 HITL 中断，run 状态变为 `cancelled` + `resumeHint: 'require-user-confirmation'`
6. 使用 `resumeRun({ resumeValue })` 恢复

如果 deepagents + FakeListChatModel 无法直接触发 interrupt（需要验证），则退化方案为：直接 mock `executeDeepagentsRun` 函数，令其返回含 interrupts 的 `DeepagentsRunResult`。

### 新建 `packages/agent/src/__tests__/helpers/agent-test-utils.ts`

```typescript
/**
 * 构造最小可用的 LoadedAgentContext，不依赖文件系统。
 * 内置 InMemorySnapshotStore 和 FakeListChatModel。
 */
createTestAgentContext(overrides?: Partial<AgentContext>): LoadedAgentContext

/**
 * 调用 session.chat() 并收集全部事件。
 */
collectChatEvents(
  session: AgentSession,
  prompt: string,
  options?: ChatOptions
): Promise<RuntimeEvent[]>
```

## 测试目录结构

```
packages/runtime/src/__tests__/
├── helpers/
│   └── runtime-test-utils.ts          # 增强现有
├── suite/                              # 新建
│   ├── multi-turn.test.ts
│   ├── tool-policy.test.ts
│   ├── concurrency.test.ts
│   ├── error-recovery.test.ts
│   ├── checkpoint-resume.test.ts
│   └── snapshot-consistency.test.ts
├── runtime.test.ts                     # 保留
├── runtime-cancel-resume.test.ts       # 保留
└── ...                                 # 保留

packages/agent/src/__tests__/
├── helpers/
│   └── agent-test-utils.ts            # 新建
├── suite/                              # 新建
│   └── session-e2e.test.ts
└── ...                                 # 保留
```

## 测试用例清单

### 1. `suite/multi-turn.test.ts` — 多轮对话连续性

验证 `runTurn` 的消息累积机制（`runtime.ts:375-386`）和 run 完成后 assistant 消息追加到 session（`runtime.ts:611-626`）。

| 用例 | 验证点 |
|------|--------|
| 连续 3 轮 runTurn，每轮 run.completed | 每轮 session snapshot 的 messages 数量递增（user+assistant 交替） |
| 第 2 轮消息历史包含第 1 轮内容 | run snapshot 的 messages 数组包含前轮 user 和 assistant 消息 |
| 中间轮触发工具调用，后续轮消息历史包含工具结果 | session messages 中包含带工具调用的 assistant 消息 |
| 每轮的 sessionId 相同，runId 不同 | 事件中 sessionId 一致，runId 各不相同 |
| 多轮后 session snapshot 的 updatedAt 单调递增 | 时间戳断言 |

### 2. `suite/tool-policy.test.ts` — 工具执行策略

验证 `ensureToolAllowed`（`tool-catalog.ts:127-137`）和 `policy.tool.allowDestructive`（`deepagents-engine.ts:387`）。

| 用例 | 验证点 |
|------|--------|
| sideEffect=none 的工具正常执行 | tool.started + tool.completed 事件，run.completed |
| sideEffect=idempotent 的工具正常执行 | 同上 |
| sideEffect=destructive + 默认策略（allowDestructive=false）被拦截 | 抛出 PolicyError('TOOL_DESTRUCTIVE_BLOCKED') |
| sideEffect=destructive + allowDestructive=true 正常执行 | tool.completed 事件 |
| 模型调用未注册的工具 | ToolError('TOOL_NOT_FOUND') |
| ensureToolAllowed 独立单元测试 | 各 sideEffect 级别 + allowDestructive 组合 |

### 3. `suite/concurrency.test.ts` — 并发安全

验证不同 session 并发执行时的隔离性。

| 用例 | 验证点 |
|------|--------|
| 两个不同 session 同时 runTurn，各自 run.completed | 两组事件流独立，sessionId 各自正确 |
| 并发 run 的事件流不互相污染 | 事件中 runId/sessionId 严格对应 |
| 并发 run 各自的 session snapshot 独立更新 | 分别查询 snapshot，messages 互不包含对方内容 |
| 一个 session 的 run 失败不影响另一个 | session A run.failed，session B run.completed |
| 取消一个 session 的 run 不影响另一个 | cancelRun(A) 后 B 仍正常完成 |

### 4. `suite/error-recovery.test.ts` — 错误恢复与降级

验证 `executeRun` 的错误处理分支（`runtime.ts:635-681`）和工具错误映射（`deepagents-engine.ts:448-487`）。

| 用例 | 验证点 |
|------|--------|
| 模型抛异常 | run.failed 事件，RunSnapshot.status='failed'，metadata 含 failureCode |
| 工具 execute 抛异常 | tool.failed 事件，错误归一化为 ToolError |
| 工具执行超时 | tool.failed + ToolError('TOOL_TIMEOUT') |
| run 失败后同 session 可发起新 runTurn | 新 run 正常 completed，session 未被关闭 |
| AbortSignal 已 aborted 的情况下发起 runTurn | run.cancelled 事件，cancelPoint='assistant_turn' |
| cancelRun 触发取消 | run.cancelled，事件流正确终止 |
| 取消时有 destructive 工具在执行 | pendingOperation 标记 'aborted-with-side-effect'，resumeHint='require-user-confirmation' |
| 取消时只有 none/idempotent 工具 | pendingOperation 标记 'aborted-clean'，resumeHint='replay' |

### 5. `suite/checkpoint-resume.test.ts` — Checkpoint + HITL 恢复

验证 interrupt 处理（`runtime.ts:575-601`）和 resumeRun 流程（`runtime.ts:403-471`）。

| 用例 | 验证点 |
|------|--------|
| 工具触发 interrupt，run 变为 cancelled | RunSnapshot: status='cancelled', cancelPoint='human-in-the-loop', resumeHint='require-user-confirmation' |
| interrupt 后 workflowState 包含 threadId/checkpointId/interrupts | workflowState.kind='deepagents-interrupt' |
| resumeRun 成功恢复 | 新 run triggerType='resume'，parentRunId 指向原 run |
| resumeRun 缺少 resumeValue 时报错 | TianjiError('MISSING_RESUME_VALUE') |
| resumeRun 对非 cancelled run 报错 | TianjiError('RUN_NOT_CANCELLABLE') |
| resume 后 metadata 记录 resumedFromRunId | 新 run snapshot 验证 |
| 多次 interrupt-resume 循环状态一致 | 每次 interrupt/resume 的快照链完整 |

注意：此组测试依赖 checkpoint mock 能力。实现时需先验证 FakeListChatModel + interruptOn 是否能触发 interrupt。若不能，使用 `vi.mock` 替换 `executeDeepagentsRun`。

### 6. `suite/snapshot-consistency.test.ts` — 快照一致性

验证各终止状态下快照的完整性。

| 用例 | 验证点 |
|------|--------|
| run completed 后 RunSnapshot | status='completed'，messages 包含 user+assistant，pendingOperations 记录已完成工具 |
| run cancelled 后 RunSnapshot | status='cancelled'，cancelPoint 存在，pendingOperations 状态正确 |
| run failed 后 RunSnapshot | status='failed'，metadata.failureCode 存在 |
| run completed 后 SessionSnapshot | messages 追加了 assistant 消息，updatedAt 更新 |
| closeSession 后 SessionSnapshot | metadata.closedAt 存在 |
| closeSession 中止活跃 run | 活跃 run 变为 cancelled |
| closed session 拒绝新 runTurn | TianjiError('SESSION_CLOSED') |
| closed session 拒绝 resumeRun | TianjiError('SESSION_CLOSED') |
| InMemorySnapshotStore 和 FileSnapshotStore 行为一致 | 同一组操作在两种 store 上结果相同 |

### 7. `packages/agent/src/__tests__/suite/session-e2e.test.ts` — Agent Session Facade

验证 `createAgentRuntime` + `createAgentSession` 的端到端行为，不 mock runtime 内部。

| 用例 | 验证点 |
|------|--------|
| session.chat(prompt) 返回完整事件流 | 包含 run.started, message.started, message.delta, message.completed, run.completed |
| systemPrompt 从 agent soul 注入 | runtime 收到的 systemPrompt 匹配 context.agent.soul |
| ChatOptions.systemPrompt 覆盖默认 soul | runtime 收到的是覆盖值 |
| 连续两次 chat() 使用同一 sessionId | 两次事件中 sessionId 相同 |
| 第二次 chat() 的消息历史包含第一轮内容 | 验证多轮累积 |

## 实现顺序

1. **基础设施先行** — 增强 `runtime-test-utils.ts`，新建 `agent-test-utils.ts`
2. **从简单到复杂** — multi-turn → tool-policy → snapshot-consistency → error-recovery → concurrency → checkpoint-resume → session-e2e
3. **每个文件独立可运行** — 不依赖其他 suite 文件的执行顺序

## 与现有测试的关系

新增的 `suite/` 测试不替代现有测试。现有测试覆盖的是更细粒度的单元行为（如 `runtime-cancel-resume.test.ts` 中的取消信号传播、`tool-catalog.test.ts` 中的注册逻辑）。`suite/` 测试从使用者视角验证多个组件组合后的行为正确性。
