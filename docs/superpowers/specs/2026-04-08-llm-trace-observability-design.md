# LLM 链路完整可观测性与持久化设计

**日期：** 2026-04-08
**状态：** 待实现
**前置依赖：** `2026-04-08-deepagents-event-observability-design.md`（工具事件捕获与去重，已合入）

---

## 背景与问题

### 现状

上一份 spec 解决了"内置工具事件不可见"的问题。但 LLM 链路的可观测性仍有三个关键缺失：

| 缺失项 | 现状 | 影响 |
|---|---|---|
| **thinking** | `on_chat_model_stream` 只提取 text，thinking 内容被丢弃 | 无法追踪 LLM 的推理过程 |
| **tool call 完整结构** | `buildAssistantMessage` 只构建 `TextContent`，LLM 返回的 tool_calls 被丢弃 | RunSnapshot 中看不到 LLM 调了什么工具、传了什么参数 |
| **tool result** | `executeDeepagentsToolCall` 返回 result 后只更新 `pendingOperations` 状态，result 内容不进 message | RunSnapshot 中看不到工具返回了什么 |

最终效果：RunSnapshot 的 `messages` 数组里只有 `user(text) → assistant(text)`，中间所有 thinking、tool call、tool result 全部丢失。日志层面同样缺失——tool 日志只打 toolName，不打 args 和 result。

### 目标

一个 run 结束后，RunSnapshot 的 messages 和日志中能完整还原 LLM 的决策链路：

```
用户输入 → LLM 思考 → LLM 输出文本 → LLM 请求调用工具(含参数)
→ 工具执行结果 → LLM 继续思考 → LLM 最终输出
```

---

## 设计方案

### 第一层：数据结构变更（`packages/shared/src/message.ts`）

#### 1.1 新增 `tool` role

```typescript
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'
```

#### 1.2 新增 `ToolResultContent`

```typescript
export interface ToolResultContent {
  readonly type: 'tool-result'
  readonly toolCallId: string
  readonly toolName: string
  readonly result: unknown
  readonly isError?: boolean
}
```

#### 1.3 扩展 `MessagePart`

```typescript
export type MessagePart =
  | TextContent
  | ThinkingContent
  | ImageContent
  | ToolCall
  | ToolResultContent
```

#### 1.4 目标消息序列（OpenAI 风格）

一个包含多轮 tool call 的 run，messages 数组应为：

```json
[
  {
    "role": "user",
    "content": [{ "type": "text", "text": "帮我读取 src/main.ts 并统计行数" }]
  },
  {
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "用户想读文件并统计行数，我先调用 read_file" },
      { "type": "tool-call", "toolCallId": "call_abc", "toolName": "read_file", "args": {"path": "src/main.ts"} }
    ]
  },
  {
    "role": "tool",
    "content": [
      { "type": "tool-result", "toolCallId": "call_abc", "toolName": "read_file", "result": "import { app }...", "isError": false }
    ]
  },
  {
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "文件有 42 行" },
      { "type": "text", "text": "src/main.ts 共 42 行" }
    ]
  }
]
```

规则：
- 一条 `assistant` 消息可以同时包含 `ThinkingContent`、`TextContent`、`ToolCall`
- 每个 `tool-call` 对应一条 `tool` role 消息（包含 `ToolResultContent`）
- 工具失败时 `isError: true`，`result` 存放错误信息
- 多个 tool call 可以在同一条 assistant 消息中（并行调用），对应多条 tool 消息

---

### 第二层：deepagents-engine 捕获逻辑（`packages/runtime/src/engines/deepagents-engine.ts`）

当前 `executeDeepagentsRun` 只维护一个 `aggregatedText` 和一个 `finalMessage`。需要改为维护**完整的消息追踪列表**。

#### 2.1 新增 per-run 追踪状态

```typescript
// 替代原有的单一 aggregatedText + finalMessage
const turnMessages: AppMessage[] = []
let currentThinking = ''
let currentText = ''
let currentToolCalls: ToolCall[] = []
```

#### 2.2 thinking 捕获

LangChain 的 `on_chat_model_stream` chunk 中，thinking 内容可能出现在以下位置（取决于模型提供者）：

| 提供者 | thinking 字段路径 |
|---|---|
| Anthropic (Claude) | `chunk.kwargs.additional_kwargs.thinking` 或 `chunk.content` 中 type 为 `thinking` 的 block |
| OpenAI (o-series) | `chunk.kwargs.additional_kwargs.reasoning_content` |
| DeepSeek | `chunk.kwargs.additional_kwargs.reasoning_content` |

新增 `readChunkThinking` 函数：

```typescript
function readChunkThinking(chunk: unknown): string {
  // 优先检查 content 数组中的 thinking block（Anthropic 格式）
  const contentBlocks = readContentBlocks(chunk)
  for (const block of contentBlocks) {
    if (isRecord(block) && block.type === 'thinking' && typeof block.thinking === 'string') {
      return block.thinking
    }
  }

  // 检查 additional_kwargs 中的 reasoning_content（OpenAI/DeepSeek 格式）
  const kwargs = readChunkKwargs(chunk)
  const additionalKwargs = isRecord(kwargs?.additional_kwargs) ? kwargs!.additional_kwargs : undefined
  if (typeof additionalKwargs?.reasoning_content === 'string') {
    return additionalKwargs.reasoning_content
  }

  return ''
}

function readContentBlocks(chunk: unknown): Array<Record<string, unknown>> {
  if (!isRecord(chunk)) return []
  if (Array.isArray(chunk.content)) return chunk.content.filter(isRecord)
  const kwargs = readChunkKwargs(chunk)
  if (Array.isArray(kwargs?.content)) return kwargs!.content.filter(isRecord)
  return []
}
```

#### 2.3 事件循环改造

```typescript
for await (const event of events) {
  if (event.event === 'on_chat_model_stream') {
    // ── text ──
    const text = readChunkText(event.data?.chunk)
    if (text.length > 0) {
      currentText += text
      options.emitEvent({ type: 'message.delta', channel: 'text', ... })
    }

    // ── thinking ──
    const thinking = readChunkThinking(event.data?.chunk)
    if (thinking.length > 0) {
      currentThinking += thinking
      options.emitEvent({ type: 'message.delta', channel: 'thinking', ... })
    }

    registerObservedToolCalls(event.data?.chunk, observedToolCalls)
    continue
  }

  if (event.event === 'on_chat_model_end') {
    registerObservedToolCalls(event.data?.output, observedToolCalls)

    // ── 模型输出结束，构建一条完整的 assistant 消息 ──
    // 包含本轮积累的 thinking + text + tool_calls
    const parts: MessagePart[] = []
    if (currentThinking.length > 0) {
      parts.push({ type: 'thinking', thinking: currentThinking })
    }
    if (currentText.length > 0) {
      parts.push({ type: 'text', text: currentText })
    }
    // 从 observedToolCalls 中提取未消费的 tool calls
    for (const tc of readUnconsumedToolCalls(observedToolCalls)) {
      parts.push({
        type: 'tool-call',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
      })
    }

    if (parts.length > 0) {
      const assistantMsg: AppMessage = {
        id: `msg_${randomUUID()}`,
        role: 'assistant',
        content: parts,
        createdAt: Date.now(),
      }
      turnMessages.push(assistantMsg)
    }

    // 重置单轮累积
    currentThinking = ''
    currentText = ''
    continue
  }

  // on_tool_start / on_tool_end 保持现有逻辑（事件 emit + 去重）
  // ...

  if (isLangGraphChainEnd(event)) {
    // 最终 fallback：如果 on_chat_model_end 没触发，用 output 兜底
    // 但不覆盖已通过 on_chat_model_end 构建的消息
    continue
  }
}
```

#### 2.4 tool result 消息构建

在 `executeDeepagentsToolCall` 中，工具执行完成后，构建 `tool` role 消息并追加到 `turnMessages`：

```typescript
// executeDeepagentsToolCall 需要接收 turnMessages 引用
async function executeDeepagentsToolCall(
  options: ExecuteDeepagentsRunOptions,
  observedToolCalls: DeepagentsPendingToolCall[],
  turnMessages: AppMessage[],  // ← 新增
  input: { ... }
): Promise<unknown> {
  // ... 现有逻辑 ...

  try {
    const result = await executeWithTimeout(...)

    // ── 新增：构建 tool result 消息 ──
    turnMessages.push({
      id: `msg_${randomUUID()}`,
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId,
        toolName: input.toolName,
        result,
        isError: false,
      }],
      createdAt: Date.now(),
    })

    // 同时 emit tool.completed 事件（带完整 result）
    options.emitEvent({
      type: 'tool.completed',
      runId: options.runId,
      toolCallId,
      invocation,
      result: { toolCallId, result },
      timestamp: Date.now(),
    })

    return result
  } catch (error) {
    // ── 新增：构建失败的 tool result 消息 ──
    turnMessages.push({
      id: `msg_${randomUUID()}`,
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId,
        toolName: input.toolName,
        result: resolvedError.message,
        isError: true,
      }],
      createdAt: Date.now(),
    })

    // ... 现有 tool.failed emit 逻辑 ...
  }
}
```

#### 2.5 最终消息返回

run 结束时，返回完整的 `turnMessages` 而不是单个 `finalMessage`：

```typescript
// DeepagentsRunResult 改为返回消息列表
export interface DeepagentsRunResult {
  readonly turnMessages: AppMessage[]  // ← 替代 finalMessage
  readonly threadId: string
  readonly checkpointId?: string
  readonly interrupts?: readonly DeepagentsInterruptRecord[]
}
```

---

### 第三层：runtime 持久化（`packages/runtime/src/runtime.ts`）

#### 3.1 session/run snapshot 保存完整消息

```typescript
// executeRun 中，run 完成后
const result = await this.executeDeepagentsTurn(activeRun, input, context)

const nextSessionSnapshot: SessionSnapshot = {
  ...input.sessionSnapshot,
  // 追加本次 turn 产生的所有消息（而不是只追加一条 finalMessage）
  messages: [...input.sessionSnapshot.messages, ...result.turnMessages],
  updatedAt: Date.now(),
}

const completedRunSnapshot: RunSnapshot = {
  ...runSnapshot,
  status: 'completed',
  messages: nextSessionSnapshot.messages,
  updatedAt: Date.now(),
  pendingOperations: [...context.pendingOperations.values()],
  metadata: completedRunMetadata,
}
```

#### 3.2 message.completed 事件

`message.completed` 仍然只发最后一条 assistant 消息（保持事件语义不变，用于流式 UI 判断 turn 结束）：

```typescript
const lastAssistantMessage = result.turnMessages.findLast(m => m.role === 'assistant')

if (lastAssistantMessage !== undefined) {
  options.emitEvent({
    type: 'message.completed',
    runId: options.runId,
    messageId: lastAssistantMessage.id,
    message: lastAssistantMessage,
    timestamp: Date.now(),
  })
}
```

---

### 第四层：日志完善

#### 4.1 runtime 层 tool 日志（`runtime.ts` 的 `logToolEvent`）

当前只打 `toolName`，改为打印完整结构：

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
      args: event.invocation.args,          // ← 新增
    })
  } else if (event.type === 'tool.completed') {
    void logger.info(['runtime', 'tool'], 'tool.completed', {
      sessionId: fields.sessionId,
      runId: fields.runId,
      toolCallId: event.toolCallId,
      toolName: event.invocation.toolName,  // ← 新增
      result: event.result.result,          // ← 新增
    })
  } else {
    void logger.error(['runtime', 'tool'], 'tool.failed', {
      sessionId: fields.sessionId,
      runId: fields.runId,
      toolCallId: event.toolCallId,
      toolName: event.invocation.toolName,  // ← 新增
      args: event.invocation.args,          // ← 新增
      errorCode: event.error.code,
      errorMessage: event.error.message,    // ← 新增
    })
  }
}
```

#### 4.2 新增 message 日志和 thinking 日志

在 `emitEvent` 回调中增加 message 类事件的日志：

```typescript
emitEvent: (event) => {
  activeRun.events.push(event)

  // tool 事件日志（已有）
  if (event.type === 'tool.started' || event.type === 'tool.completed' || event.type === 'tool.failed') {
    this.logToolEvent(event, lineage)
  }

  // 新增：message 事件日志
  if (event.type === 'message.completed') {
    this.logMessageEvent(event, lineage)
  }
}
```

```typescript
private logMessageEvent(
  event: MessageCompletedEvent,
  fields: RunLineageFields
): void {
  const logger = this.options.logger
  if (logger === undefined) return

  const hasThinking = event.message.content.some(p => p.type === 'thinking')
  const hasToolCalls = event.message.content.some(p => p.type === 'tool-call')
  const textParts = event.message.content
    .filter((p): p is TextContent => p.type === 'text')
    .map(p => p.text)

  void logger.info(['runtime', 'message'], 'message.completed', {
    sessionId: fields.sessionId,
    runId: fields.runId,
    messageId: event.messageId,
    role: event.message.role,
    hasThinking,
    hasToolCalls,
    textPreview: textParts.join('').slice(0, 200),
  })
}
```

#### 4.3 task-executor 层日志补全（`apps/node/src/task/task-executor.ts`）

tool.completed 日志补充 args 和 result：

```typescript
} else if (event.type === 'tool.completed') {
  turn.toolCallCount += 1
  void logger?.logInfo(scope, 'Tool call completed', {
    taskId,
    runId: event.runId,
    toolCallId: event.toolCallId,
    toolName: event.invocation.toolName,
    args: event.invocation.args,      // ← 新增
    result: event.result.result,      // ← 新增
  })
}
```

---

## 涉及文件总表

| 文件 | 改动 |
|---|---|
| `packages/shared/src/message.ts` | 新增 `tool` role、`ToolResultContent` 类型、扩展 `MessagePart` |
| `packages/runtime/src/engines/deepagents-engine.ts` | 新增 `readChunkThinking`、`readContentBlocks`；事件循环改为维护 `turnMessages`；`on_chat_model_end` 构建完整 assistant 消息；`executeDeepagentsToolCall` 构建 tool result 消息；`DeepagentsRunResult` 返回 `turnMessages` |
| `packages/runtime/src/runtime.ts` | `executeRun` 中用 `turnMessages` 替代 `finalMessage` 追加到 snapshot；`logToolEvent` 补充 args/result；新增 `logMessageEvent`；emitEvent 回调增加 message 日志 |
| `apps/node/src/task/task-executor.ts` | tool.completed/tool.failed 日志补充完整字段 |

---

## 不改动的部分

| 项 | 原因 |
|---|---|
| `packages/shared/src/events.ts` | RuntimeEvent 类型定义已经包含完整的 invocation/result/error 字段，不需要扩展 |
| `packages/shared/src/snapshot.ts` | RunSnapshot 的 `messages: AppMessage[]` 类型天然支持新的消息结构，不需要改 |
| `packages/runtime/src/snapshot-store.ts` | 纯 JSON 序列化，不关心 message 内部结构 |
| `message.delta` 事件 | 新增 `channel: 'thinking'` 的 delta 发射，但 `MessageDeltaEvent` 接口已定义 `channel: MessageDeltaChannel`（`'text' | 'thinking'`），不需要改类型 |

---

## 实现顺序

| 步骤 | 内容 | 依赖 |
|---|---|---|
| 1 | `packages/shared/src/message.ts` 数据结构变更 | 无 |
| 2 | `deepagents-engine.ts`：新增 `readChunkThinking`/`readContentBlocks`，thinking 捕获 | Step 1 |
| 3 | `deepagents-engine.ts`：事件循环改造，`on_chat_model_end` 构建完整 assistant 消息，维护 `turnMessages` | Step 2 |
| 4 | `deepagents-engine.ts`：`executeDeepagentsToolCall` 构建 tool result 消息 | Step 3 |
| 5 | `deepagents-engine.ts`：`DeepagentsRunResult` 返回 `turnMessages`，调整 `message.completed` 发射 | Step 4 |
| 6 | `runtime.ts`：适配 `turnMessages`，snapshot 持久化完整消息 | Step 5 |
| 7 | `runtime.ts` + `task-executor.ts`：日志补全 | Step 6 |
| 8 | 测试：单元测试 + 冒烟测试验证 | Step 7 |

---

## 验收标准

1. RunSnapshot 的 messages 中包含 `thinking`、`tool-call`、`tool-result` 类型的 MessagePart
2. `runtime-snapshots/runs/{runId}.json` 文件可以完整还原一次 LLM turn 的决策链路
3. 日志中 `tool.started` 包含 args，`tool.completed` 包含 result，`tool.failed` 包含 errorMessage
4. 日志中 `message.completed` 包含 hasThinking/hasToolCalls 字段
5. `message.delta` 事件的 `channel: 'thinking'` 正确发射
6. `pnpm check` 通过
7. 冒烟测试通过

---

## 风险与边界

| 风险 | 应对 |
|---|---|
| thinking 字段路径因 LangChain 版本变化 | `readChunkThinking` 多路径兜底，无匹配时返回空字符串，不影响主流程 |
| tool result 内容过大（如读取大文件） | 日志层面截断（`result` 字段 slice 前 500 字符），snapshot 层面保留完整内容 |
| `on_chat_model_end` 在某些 LangGraph 版本不触发 | `isLangGraphChainEnd` 作为 fallback 兜底构建最终消息 |
| `turnMessages` 为空（LLM 无输出） | 保持现有 `RUN_EMPTY_RESPONSE` 错误抛出 |
