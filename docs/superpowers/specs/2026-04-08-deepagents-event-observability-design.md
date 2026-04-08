# Deep Agent 全量事件可观测性设计文档

**日期：** 2026-04-08  
**状态：** 部分实现  
**最后更新：** 2026-04-08（review 后修订，对照代码勘误）

---

## 背景与问题

### 现状

`deepagents-engine.ts` 中的事件循环已处理 5 种 LangGraph streamEvents v2 事件：

| 事件 | 处理方式 | 状态 |
|------|----------|------|
| `on_chat_model_stream` | 提取文本增量 → `message.delta`；注册 observed tool calls | 已实现 |
| `on_chat_model_end` | 注册 observed tool calls | 已实现 |
| `on_chain_end`（name=LangGraph） | 提取最终消息 | 已实现 |
| `on_tool_start` | 映射为 `tool.started` | 已实现，有 bug |
| `on_tool_end` | 映射为 `tool.completed` | 已实现，有 bug |

其余事件（`on_chain_start`、`on_chat_model_start` 等）仍被静默丢弃（设计上暂不处理，见"已移除"章节）。

### 已解决的问题

1. ~~Deep Agent 内置工具不产生 `tool.started` / `tool.completed` 事件~~ — 事件循环已捕获 `on_tool_start` / `on_tool_end`。
2. ~~`@tianji/observer` 的 `startToolSpan` 从未被调用~~ — `runtime.ts` 的 `emitEvent` 回调已接入 OTel span。
3. ~~`tool.failed` 日志级别错误~~ — 已在 `b26b497` 中修复。

### 遗留问题

1. **`on_tool_start` 和 `on_tool_end` 的 `toolCallId` 无法关联**：两个事件各自生成独立的 `randomUUID()`，同一次工具调用的 start 和 end 的 ID 不同。导致 `runtime.ts` 中的 OTel span 在 `tool.completed` 时找不到对应的 span，永远无法关闭。
2. **`on_tool_end` 丢失工具入参**：`tool.completed` 事件的 `invocation.args` 硬编码为 `{}`，无法追溯调用参数。
3. **`DeepagentsAgentEvent` 接口缺少 `run_id` 字段**：langgraph 的 `StreamEvent` 实际包含 `run_id`（每个 runnable 执行的唯一 ID），但当前接口未声明，无法用于关联同一次工具调用的 start/end。
4. LLM 调用的开始时间、模型名称等信息未被捕获（暂不处理，见"已移除"章节）。
5. 子图（subagent）的执行过程完全不可见（暂不处理）。

### 影响

- OTel tool span 泄漏：每次工具调用创建的 span 永远不会被 end()。
- `tool.completed` 事件缺少入参信息，排障时无法看到工具被调用时的参数。

---

## 设计目标

1. 修复 `on_tool_start` / `on_tool_end` 的 `toolCallId` 关联问题，确保同一次工具调用的事件可追踪。
2. 补全 `tool.completed` 事件中的 `invocation.args`。
3. 保持现有消费者（TaskExecutor、observer logger、OTel span）无需改动。

---

## 设计方案

### ~~`agent.activity` 事件类型~~ [推迟]

> **Review 结论：违反 KISS 原则，推迟实施。**
>
> `agent.activity`（`llm.start` / `llm.end` / `chain.start` / `chain.end`）当前没有任何消费者。
> 待后续有具体需求（如 LLM 调用耗时监控、子图可视化）时再引入。

### 第一步：扩展 `DeepagentsAgentEvent` 接口，增加 `run_id` [未实现]

langgraph 的 `StreamEvent` 包含 `run_id` 字段（每个 runnable 执行的唯一 ID），同一次工具调用的 `on_tool_start` 和 `on_tool_end` 共享同一个 `run_id`。当前 `DeepagentsAgentEvent` 接口未声明该字段。

```typescript
// 当前（缺少 run_id）
interface DeepagentsAgentEvent {
  readonly event: string
  readonly name: string
  readonly data?: Record<string, unknown>
}

// 修改后
interface DeepagentsAgentEvent {
  readonly event: string
  readonly name: string
  readonly run_id: string   // langgraph 为每个 runnable 执行分配的唯一 ID
  readonly data?: Record<string, unknown>
}
```

### 第二步：用 `run_id` 关联 start/end，用 Map 缓存入参 [未实现]

当前代码的两个 bug：
1. `on_tool_start` 和 `on_tool_end` 各自生成独立的 `randomUUID()`，同一次工具调用的 ID 对不上
2. `on_tool_end` 的 `invocation.args` 硬编码为 `{}`，丢失入参

修复方案：用 `event.run_id` 作为 `toolCallId`，用 Map 缓存 start 时的 invocation 供 end 时复用。

```typescript
// 在事件循环外部初始化（per-turn 作用域）
const builtinToolInvocations = new Map<string, ToolInvocation>()

if (event.event === 'on_tool_start') {
  const toolCallId = event.run_id  // 用 langgraph 的 run_id，不再 randomUUID()
  const invocation: ToolInvocation = {
    toolCallId,
    toolName: event.name,
    args: (event.data?.input ?? {}) as Record<string, unknown>,
  }
  builtinToolInvocations.set(toolCallId, invocation)
  options.emitEvent({
    type: 'tool.started',
    runId: options.runId,
    toolCallId,
    invocation,
    timestamp: Date.now(),
  })
  continue
}

if (event.event === 'on_tool_end') {
  const toolCallId = event.run_id
  const invocation = builtinToolInvocations.get(toolCallId)
  if (invocation === undefined) {
    // start 事件丢失，不应发生，let it crash
    throw new TianjiError('engine', 'TOOL_EVENT_ORPHAN', `on_tool_end without matching on_tool_start: ${toolCallId}`)
  }
  builtinToolInvocations.delete(toolCallId)
  options.emitEvent({
    type: 'tool.completed',
    runId: options.runId,
    toolCallId,
    invocation,   // 复用 start 时缓存的完整 invocation
    result: {
      toolCallId,
      result: event.data?.output,
    },
    timestamp: Date.now(),
  })
  continue
}
```

**解决的问题：**

| 问题 | 修复方式 |
|------|----------|
| start/end 的 toolCallId 对不上 | 统一使用 `event.run_id` |
| `on_tool_end` 丢失入参 | Map 缓存 start 时的 invocation |
| OTel span 无法关闭 | toolCallId 一致后，runtime 的 `toolSpans.get()` 能正确匹配 |

### ~~第三步：事件去重~~ [已移除]

> **勘误：去重方案解决的是一个不存在的问题。**
>
> 原设计假设 `executeDeepagentsToolCall` 会 emit `tool.started` / `tool.completed`，与事件循环的 `on_tool_start` / `on_tool_end` 产生重复。但实际代码中 `executeDeepagentsToolCall` 只 emit `tool.failed`（发生异常时），不 emit `tool.started` 和 `tool.completed`。
>
> 因此：
> - **内置工具**（ls/read 等）：事件只来自事件循环的 `on_tool_start` / `on_tool_end`，无重复。
> - **外部工具**（ToolCatalog 注册的）：事件也只来自事件循环的 `on_tool_start` / `on_tool_end`，无重复。`tool.failed` 只在异常时由 `executeDeepagentsToolCall` emit，且 `on_tool_end` 不会在工具执行失败时触发（langgraph 在异常时不产生 `on_tool_end`），也无重复。
>
> 不需要 `emittedToolCallIds` Set，不需要去重逻辑。
>
> 原设计中 `run_id === toolCallId` 的假设也是错误的：langgraph 的 `run_id` 是 runnable 执行 ID，与 LLM 输出的 `tool_call.id` 是两套 ID 体系。

### ~~第三步：observer 日志~~ [已实现]

> 已在 `runtime.ts:718-748` 中实现。`emitEvent` 回调中对 `tool.started` / `tool.completed` / `tool.failed` 调用 `logToolEvent`。

### ~~第四步：OpenTelemetry span~~ [已实现]

> 已在 `runtime.ts:699-747` 中实现。`toolSpans` Map 在 `executeRun` 闭包内定义，per-run 隔离。
>
> **注意：** 当前因为第二步的 bug（start/end 的 toolCallId 不一致），span 实际上无法被正确关闭。第二步修复后此问题自动解决。

---

## LangGraph StreamEvent 字段映射

| LangGraph 字段 | 映射目标 | 说明 |
|---|---|---|
| `event` | 事件类型判断 | `on_tool_start` → `tool.started`，`on_tool_end` → `tool.completed` |
| `name` | `invocation.toolName` | runnable 名称（工具名） |
| `run_id` | `toolCallId` | 同一次工具调用的 start/end 共享同一个 `run_id`，用于关联 |
| `data.input` | `invocation.args` | 工具输入参数（仅 `on_tool_start` 携带） |
| `data.output` | `result.result` | 工具输出结果（仅 `on_tool_end` 携带） |

> **注意：** `run_id` 和 LLM 输出的 `tool_call.id` 是两套 ID 体系。`run_id` 是 langgraph 为每个 runnable 执行分配的 ID，`tool_call.id` 是模型在生成工具调用时分配的 ID。两者没有对应关系。

---

## 涉及文件

| 文件 | 改动 | 状态 |
|------|------|------|
| `packages/runtime/src/engines/deepagents-engine.ts` | 扩展 `DeepagentsAgentEvent` 接口增加 `run_id`；用 `run_id` 关联 start/end；用 Map 缓存 invocation | 未实现 |
| `packages/runtime/src/runtime.ts` | emitEvent 回调中增加 observer logger 和 OTel span | 已实现 |
| `packages/observer/src/tracing/spans.ts` | 无改动 | — |
| `apps/node/src/task/task-executor.ts` | `tool.failed` 日志级别修复 | 已实现（`b26b497`） |

---

## 实现顺序

1. ~~**前置清理：task-executor 日志修复**~~ — 已完成（`b26b497`）
2. **deepagents-engine**：扩展 `DeepagentsAgentEvent` 接口增加 `run_id`；用 `run_id` 替代 `randomUUID()` 关联 start/end；用 `builtinToolInvocations` Map 缓存入参
3. ~~**runtime observer 日志**~~ — 已完成（`58f55ee`）
4. ~~**runtime OTel span**~~ — 已完成（`58f55ee`），但因 bug #1 当前 span 无法正确关闭，第 2 步修复后自动生效
5. **测试**：验证内置工具（ls/execute）的 `tool.started` 和 `tool.completed` 的 `toolCallId` 一致；验证 OTel span 被正确关闭

---

## 验收标准

1. 同一次工具调用的 `tool.started` 和 `tool.completed` 事件的 `toolCallId` 相同。
2. `tool.completed` 事件的 `invocation.args` 包含实际入参，不为空对象。
3. `runtime.ts` 中的 `toolSpans` Map 在工具完成后被正确清理（span 被 end）。
4. `pnpm check` 通过，无类型错误。
