# Deep Agent 全量事件可观测性设计文档

**日期：** 2026-04-08  
**状态：** 待实现  
**最后更新：** 2026-04-08（review 后修订）

---

## 背景与问题

### 现状

当前 `deepagents-engine.ts` 中的事件循环只处理 3 种 LangGraph streamEvents v2 事件：

| 事件 | 处理方式 |
|------|----------|
| `on_chat_model_stream` | 提取文本增量 → `message.delta`；注册 observed tool calls |
| `on_chat_model_end` | 注册 observed tool calls |
| `on_chain_end`（name=LangGraph） | 提取最终消息 |

其余事件（`on_tool_start`、`on_tool_end`、`on_chain_start`、`on_chat_model_start` 等）全部被静默丢弃。

### 问题

1. Deep Agent 通过 `createFilesystemMiddleware` 自动注入的内置工具（ls、read、write、edit、execute）执行时，走的是 LangGraph 内部的 tool node，不经过 runtime 的 `executeDeepagentsToolCall`，因此不会产生 `tool.started` / `tool.completed` 事件。
2. LLM 调用的开始时间、模型名称等信息未被捕获。
3. 子图（subagent）的执行过程完全不可见。
4. 已有的 `@tianji/observer` 的 `startToolSpan` 等 OpenTelemetry span 从未在 runtime 中被调用。

### 影响

- TaskExecutor 日志中 `toolCallCount: 0`，即使 agent 实际执行了工具。
- 无法追踪 agent 的决策链路：模型思考 → 调用工具 → 获取结果 → 继续思考。
- 运维排障缺少关键信息。

---

## 设计目标

1. 捕获 LangGraph streamEvents v2 的所有事件类型，不丢弃任何行为信息。
2. 将 `on_tool_start` / `on_tool_end` 映射为已有的 `tool.started` / `tool.completed` / `tool.failed`，使现有消费者（TaskExecutor、observer logger）无需改动即可生效。
3. 为 LLM 调用、chain 执行等非工具事件提供统一的事件类型，供上层按需消费。
4. 在 runtime 层接入 observer 的 OpenTelemetry span。

---

## 设计方案

### ~~第一步：在 RuntimeEvent 中新增 `agent.activity` 事件类型~~ [已移除]

> **Review 结论：违反 KISS 原则，推迟实施。**
>
> `agent.activity`（`llm.start` / `llm.end` / `chain.start` / `chain.end`）当前没有任何消费者：
> - TaskExecutor 只关心 `tool.*` / `run.*` / `message.*`
> - observer logger 没有对 LLM/chain 事件的处理逻辑
>
> 在没有明确消费者之前，新增事件类型只会增加维护负担。待后续有具体需求（如 LLM 调用耗时监控、子图可视化）时再引入。

### 第一步：修改 deepagents-engine.ts 事件循环

当前循环结构：

```typescript
for await (const event of events) {
  if (event.event === 'on_chat_model_stream') { ... continue }
  if (event.event === 'on_chat_model_end') { ... continue }
  if (isLangGraphChainEnd(event)) { ... }
}
```

改为：

```typescript
for await (const event of events) {
  // ── 现有逻辑保持不变 ──
  if (event.event === 'on_chat_model_stream') { ... continue }
  if (event.event === 'on_chat_model_end') { ... continue }
  if (isLangGraphChainEnd(event)) { ... }

  // ── 新增：捕获工具事件 ──
  if (event.event === 'on_tool_start') {
    // 映射为 tool.started，复用已有 RuntimeEvent 类型
    emitEvent({ type: 'tool.started', ... })
    continue
  }
  if (event.event === 'on_tool_end') {
    // 映射为 tool.completed
    emitEvent({ type: 'tool.completed', ... })
    continue
  }

  // 注意：on_chat_model_start / on_chain_start / on_chain_end 等事件
  // 暂不处理，待有明确消费者需求时再引入 agent.activity 事件类型
}
```

### 第二步：处理内置工具与外部工具的事件去重

当前外部工具（通过 `createDeepagentsTools` 注册的）会产生两次事件：
- LangGraph 的 `on_tool_start` / `on_tool_end`（第一步新增）
- `executeDeepagentsToolCall` 中的 `tool.started` / `tool.completed`（已有）

需要去重。

#### 原方案（已否决）

按 ToolCatalog 名字查询判断是否跳过。问题：依赖"内置工具名字不会和 ToolCatalog 中注册的工具重名"这个脆弱假设，一旦命名冲突就会导致事件丢失。

#### 修订方案：基于 toolCallId 的 Set 去重

在 `executeDeepagentsToolCall` 中，每次 emit `tool.started` 时将 `toolCallId` 记录到一个 `Set<string>`。在 `on_tool_start` / `on_tool_end` 处理中，检查该 `run_id`（即 toolCallId）是否已在 Set 中。如果已存在，跳过；否则 emit。

```typescript
// 在事件循环外部初始化（per-turn 作用域）
const emittedToolCallIds = new Set<string>()

// executeDeepagentsToolCall 中，emit tool.started 时同步记录
emittedToolCallIds.add(toolCallId)
emitEvent({ type: 'tool.started', ... })

// 事件循环中
if (event.event === 'on_tool_start') {
  const toolCallId = event.run_id
  // 已由 executeDeepagentsToolCall 处理的工具，跳过
  if (emittedToolCallIds.has(toolCallId)) {
    continue
  }
  // 内置工具：构造 tool.started 事件
  emittedToolCallIds.add(toolCallId)
  emitEvent({
    type: 'tool.started',
    runId: options.runId,
    toolCallId,
    invocation: {
      toolCallId,
      toolName: event.name,
      args: event.data?.input ?? {},
    },
    timestamp: Date.now(),
  })
  continue
}
```

**优势：** 按唯一 ID 去重，不依赖任何命名约定，即使工具名重复也不会误判。

### 第三步：在 runtime.ts 中补充 tool 事件的 observer 日志

在 `executeRun` 方法中，对 `ReplayableEventStream` 的事件增加日志记录。在事件 push 到 stream 后，同时写入 observer logger：

```typescript
emitEvent: (event) => {
  activeRun.events.push(event)
  // 新增：tool 事件写入 observer logger
  if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.failed') {
    this.logToolEvent(event, lineage)
  }
}
```

新增 `logToolEvent` 方法：

```typescript
private logToolEvent(
  event: ToolStartedEvent | ToolCompletedEvent | ToolFailedEvent,
  fields: RunLineageFields
): void {
  const logger = this.options.logger
  if (logger === undefined) return

  if (event.type === 'tool.started') {
    void logger.info(['runtime', 'tool'], 'tool.started', {
      sessionId: fields.sessionId,
      runId: fields.runId,
      toolCallId: event.toolCallId,
      toolName: event.invocation.toolName,
    })
  } else if (event.type === 'tool.completed') {
    void logger.info(['runtime', 'tool'], 'tool.completed', {
      sessionId: fields.sessionId,
      runId: fields.runId,
      toolCallId: event.toolCallId,
    })
  } else {
    void logger.error(['runtime', 'tool'], 'tool.failed', {
      sessionId: fields.sessionId,
      runId: fields.runId,
      toolCallId: event.toolCallId,
      errorCode: event.error.code,
    })
  }
}
```

> **与 TaskExecutor 日志的关系说明：**
> 这是有意的分层日志设计。runtime 层记录所有 session 的工具事件（scope `['runtime', 'tool']`），TaskExecutor 层只记录 task 维度的汇总（scope 为 task 自身）。两者的消费场景不同：runtime 日志用于全局链路追踪，TaskExecutor 日志用于单任务执行摘要。

### 第四步：接入 OpenTelemetry span

在 `emitEvent` 回调中，对 tool 事件调用 observer 已定义的 `startToolSpan`：

```typescript
// toolSpans 是 per-run 的局部变量，在 executeRun 闭包内定义，
// run 结束后自动 GC，不存在多 run 并发时的隔离问题。
const toolSpans = new Map<string, Span>()

if (event.type === 'tool.started') {
  const span = startToolSpan({
    toolName: event.invocation.toolName,
    runId: event.runId,
  })
  // 存储 span 引用，在 tool.completed/failed 时 end
  toolSpans.set(event.toolCallId, span)
}
if (event.type === 'tool.completed' || event.type === 'tool.failed') {
  toolSpans.get(event.toolCallId)?.end()
  toolSpans.delete(event.toolCallId)
}
```

> **生命周期说明：** `toolSpans` 必须定义在 `executeRun` 方法的闭包内（而非类实例属性），确保 per-run 隔离。run 结束时闭包释放，Map 自动回收。

---

## LangGraph StreamEvent 字段映射

| LangGraph 字段 | 映射目标 | 说明 |
|---|---|---|
| `event` | 事件类型判断 | `on_tool_start` → `tool.started`，`on_tool_end` → `tool.completed` |
| `name` | `invocation.toolName` | runnable 名称（工具名） |
| `run_id` | `toolCallId` | LangGraph 内部执行 ID，同时用于 Set 去重 |
| `data.input` | `invocation.args` | 工具输入参数 |
| `data.output` | `result.result` | 工具输出结果 |
| `data.error` | `error.message` | 错误信息 |

---

## 涉及文件

| 文件 | 改动 |
|------|------|
| `packages/runtime/src/engines/deepagents-engine.ts` | 扩展事件循环，处理 `on_tool_start`/`on_tool_end`；新增 `emittedToolCallIds` Set 用于去重 |
| `packages/runtime/src/runtime.ts` | emitEvent 回调中增加 observer logger 和 OpenTelemetry span；新增 `logToolEvent` 方法 |
| `packages/observer/src/tracing/spans.ts` | 无改动（已有 `startToolSpan`，只需被调用） |
| `apps/node/src/task/task-executor.ts` | **前置清理：** 修复 `tool.failed` 日志级别（info → error）和消息文案 |

> **注意：** `packages/shared/src/events.ts` 不需要改动。`agent.activity` 事件类型推迟引入，当前所有新事件都映射到已有的 `tool.started` / `tool.completed` / `tool.failed` 类型。

---

## 实现顺序

1. **前置清理：task-executor 日志修复**
   - `tool.failed` 分支改用 `logError`，消息改为 "Tool call failed"，附带错误信息
   - 评估 `serializeRuntimeEvent` identity function 是否可删除
2. **deepagents-engine**：扩展事件循环，映射 `on_tool_start`/`on_tool_end` 为 `tool.started`/`tool.completed`；实现基于 `emittedToolCallIds` Set 的去重
3. **runtime**：emitEvent 回调中接入 observer logger（`logToolEvent`）
4. **runtime**：接入 OpenTelemetry span（`toolSpans` Map，per-run 闭包作用域）
5. **测试**：验证内置工具（ls/execute）出现在事件流和日志中；验证外部工具不产生重复事件

---

## 验收标准

1. agent 执行 `ls` 命令后，TaskExecutor 日志中 `toolCallCount >= 1`。
2. observer JSONL 日志中出现 `tool.started` 和 `tool.completed` 条目，包含工具名称。
3. 外部工具（ToolCatalog 注册的）不会产生重复事件（通过 `emittedToolCallIds` Set 去重验证）。
4. `tool.failed` 事件在 TaskExecutor 日志中为 error 级别，消息为 "Tool call failed"。
5. `pnpm check` 通过，无类型错误。

---

## 前置清理项

在实施主方案之前，需要先清理以下现有日志问题：

| 位置 | 问题 | 修复 |
|------|------|------|
| `task-executor.ts:214-221` | `tool.completed` 和 `tool.failed` 共用 `logInfo`，失败事件用 info 级别违反日志分层规则 | 拆分：`tool.completed` 用 `logInfo`，`tool.failed` 用 `logError` 并附带错误信息 |
| `task-executor.ts:216` | 日志消息 "Tool call completed" 对 `tool.failed` 语义错误 | `tool.failed` 改为 "Tool call failed" |
| `task-executor.ts:241-243` | `serializeRuntimeEvent` 是 identity function，无实际序列化逻辑 | 评估是否可直接删除（如无扩展计划则删除） |
| `runtime.ts:580` | HITL 中断用 `warn` 级别，但这是正常业务流程 | 改为 `info`（用户主动暂停不是告警） |
