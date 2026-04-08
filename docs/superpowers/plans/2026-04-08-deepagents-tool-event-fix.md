# LLM 链路完整可观测性与持久化

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 RunSnapshot 的 messages 完整还原 LLM 决策链路（thinking → text → tool-call → tool-result），修复工具事件 toolCallId 关联 bug，补全日志字段。

**Architecture:** 分 4 层推进：shared 类型 → deepagents-engine 捕获 → runtime 持久化 → 日志。工具事件按来源分工：内置工具从 streamEvents 流捕获（用 `run_id` 关联），外部工具从 `executeDeepagentsToolCall` 捕获（用 LLM 的 `tool_call.id`）。事件循环从单一 `aggregatedText` 改为 `turnMessages` 列表。

**Tech Stack:** TypeScript, Vitest, LangGraph streamEvents v2, `@tianji/shared`, `@tianji/observer`

**设计文档：**
- `docs/superpowers/specs/2026-04-08-deepagents-event-observability-design.md`（工具事件修复）
- `docs/superpowers/specs/2026-04-08-llm-trace-observability-design.md`（LLM 链路可观测性）

---

## 文件结构

| 文件 | 职责 | 改动类型 |
|------|------|----------|
| `packages/shared/src/message.ts` | 消息类型定义 | 新增 `tool` role、`ToolResultContent`、扩展 `MessagePart` |
| `packages/runtime/src/engines/deepagents-engine.ts` | deepagents 事件适配层 | 接口加 `run_id`；新增 `readChunkThinking`；事件循环重构为 `turnMessages`；工具事件分工；`executeDeepagentsToolCall` 加 tool.started/completed + tool-result 消息；`DeepagentsRunResult` 改为 `turnMessages` |
| `packages/runtime/src/runtime.ts` | runtime 持久化 + 日志 | 适配 `turnMessages`；`logToolEvent` 补全字段；新增 `logMessageEvent` |
| `apps/node/src/task/task-executor.ts` | 任务层日志 | tool.completed/failed 日志补全 args/result |
| `packages/runtime/src/__tests__/runtime.test.ts` | 集成测试 | 更新已有测试 + 新增 thinking/observer 测试 |

---

### Task 1: message.ts 数据结构变更

**Files:**
- Modify: `packages/shared/src/message.ts`

- [ ] **Step 1: 新增 `tool` role 和 `ToolResultContent`，扩展 `MessagePart`**

```typescript
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ToolResultContent {
  readonly type: 'tool-result'
  readonly toolCallId: string
  readonly toolName: string
  readonly result: unknown
  readonly isError?: boolean
}

export type MessagePart = TextContent | ThinkingContent | ImageContent | ToolCall | ToolResultContent
```

- [ ] **Step 2: 运行类型检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: 通过。`MessagePart` 是 union 扩展，现有 switch/if 分支不会因新增成员报错（只要没有 exhaustive check）。如有报错在对应位置补全新分支。

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/message.ts
git commit -m "feat(shared): add tool role, ToolResultContent to message types"
```

---

### Task 2: `DeepagentsAgentEvent` 接口增加 `run_id`

**Files:**
- Modify: `packages/runtime/src/engines/deepagents-engine.ts:67-72`

- [ ] **Step 1: 在接口中增加 `run_id` 字段**

将：

```typescript
interface DeepagentsAgentEvent {
  readonly event: string
  readonly name: string
  readonly data?: Record<string, unknown>
}
```

改为：

```typescript
interface DeepagentsAgentEvent {
  readonly event: string
  readonly name: string
  readonly run_id: string
  readonly data?: Record<string, unknown>
}
```

`run_id` 是 langgraph `StreamEvent` 的标准字段。同一次工具调用的 `on_tool_start` 和 `on_tool_end` 共享同一个 `run_id`。

- [ ] **Step 2: 运行类型检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: 通过（langgraph 的 `StreamEvent` 已包含 `run_id`，类型兼容）

- [ ] **Step 3: Commit**

```bash
git add packages/runtime/src/engines/deepagents-engine.ts
git commit -m "refactor(deepagents-engine): add run_id to DeepagentsAgentEvent interface"
```

---

### Task 3: 新增 `readChunkThinking` 辅助函数

**Files:**
- Modify: `packages/runtime/src/engines/deepagents-engine.ts`（在 `readChunkText` 函数附近，约第 635 行后）

- [ ] **Step 1: 新增 `readContentBlocks` 函数**

在 `readChunkText` 函数之后添加：

```typescript
/**
 * 从 chunk 中提取 content 数组（兼容直接属性和 kwargs 嵌套两种结构）。
 */
function readContentBlocks(chunk: unknown): Array<Record<string, unknown>> {
  if (!isRecord(chunk)) return []
  if (Array.isArray(chunk.content)) return chunk.content.filter(isRecord)
  const kwargs = readChunkKwargs(chunk)
  if (Array.isArray(kwargs?.content)) return kwargs!.content.filter(isRecord)
  return []
}
```

- [ ] **Step 2: 新增 `readChunkThinking` 函数**

紧接其后添加：

```typescript
/**
 * 读取单个模型流式 chunk 中的 thinking 增量。
 *
 * 兼容多种模型提供者的 thinking 字段路径：
 * - Anthropic (Claude): content 数组中 type 为 'thinking' 的 block
 * - OpenAI (o-series) / DeepSeek: additional_kwargs.reasoning_content
 */
function readChunkThinking(chunk: unknown): string {
  const contentBlocks = readContentBlocks(chunk)
  for (const block of contentBlocks) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      return block.thinking
    }
  }

  const kwargs = readChunkKwargs(chunk)
  const additionalKwargs = isRecord(kwargs?.additional_kwargs)
    ? (kwargs!.additional_kwargs as Record<string, unknown>)
    : undefined
  if (typeof additionalKwargs?.reasoning_content === 'string') {
    return additionalKwargs.reasoning_content
  }

  return ''
}
```

- [ ] **Step 3: 运行类型检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add packages/runtime/src/engines/deepagents-engine.ts
git commit -m "feat(deepagents-engine): add readChunkThinking for thinking content extraction"
```

---

### Task 4: 事件循环重构 — `turnMessages` + thinking 捕获

**Files:**
- Modify: `packages/runtime/src/engines/deepagents-engine.ts:125-282`（`executeDeepagentsRun` 函数）

这是最大的改动。将 `aggregatedText` + `finalMessage` 模式替换为 `turnMessages` 列表模式。

- [ ] **Step 1: 替换状态变量**

在 `executeDeepagentsRun` 函数内（约第 145-147 行），将：

```typescript
const observedToolCalls: DeepagentsPendingToolCall[] = []
let aggregatedText = ''
let finalMessage: AppMessage | undefined
```

改为：

```typescript
const observedToolCalls: DeepagentsPendingToolCall[] = []
const turnMessages: AppMessage[] = []
let currentThinking = ''
let currentText = ''
const builtinToolInvocations = new Map<string, ToolInvocation>()
```

- [ ] **Step 2: 重写 `on_chat_model_stream` 分支**

将第 182-200 行替换为：

```typescript
if (event.event === 'on_chat_model_stream') {
  const text = readChunkText(event.data?.chunk)
  if (text.length > 0) {
    currentText += text
    options.emitEvent({
      type: 'message.delta',
      runId: options.runId,
      messageId,
      sequence: nextSequence(options.sequence),
      channel: 'text',
      payload: { content: text },
      timestamp: Date.now(),
    })
  }

  const thinking = readChunkThinking(event.data?.chunk)
  if (thinking.length > 0) {
    currentThinking += thinking
    options.emitEvent({
      type: 'message.delta',
      runId: options.runId,
      messageId,
      sequence: nextSequence(options.sequence),
      channel: 'thinking',
      payload: { content: thinking },
      timestamp: Date.now(),
    })
  }

  registerObservedToolCalls(event.data?.chunk, observedToolCalls)
  continue
}
```

- [ ] **Step 3: 重写 `on_chat_model_end` 分支**

将第 202-205 行替换为：

```typescript
if (event.event === 'on_chat_model_end') {
  registerObservedToolCalls(event.data?.output, observedToolCalls)

  const parts: MessagePart[] = []
  if (currentThinking.length > 0) {
    parts.push({ type: 'thinking', thinking: currentThinking })
  }
  if (currentText.length > 0) {
    parts.push({ type: 'text', text: currentText })
  }
  for (const tc of observedToolCalls.filter((c) => !c.consumed)) {
    parts.push({
      type: 'tool-call',
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.args,
    })
  }

  if (parts.length > 0) {
    turnMessages.push({
      id: `msg_${randomUUID()}`,
      role: 'assistant',
      content: parts,
      createdAt: Date.now(),
    })
  }

  currentThinking = ''
  currentText = ''
  continue
}
```

需要在文件顶部确认 `MessagePart` 类型已从 `@tianji/shared` 导入。当前第 16-28 行的 import 中没有 `MessagePart`，需要添加。

- [ ] **Step 4: 重写 `isLangGraphChainEnd` 分支**

将第 207-215 行替换为：

```typescript
if (isLangGraphChainEnd(event)) {
  // on_chat_model_end 已构建消息。这里只做兜底：
  // 如果 turnMessages 为空（某些 LangGraph 版本不触发 on_chat_model_end），
  // 用 output 构建最终消息。
  if (turnMessages.length === 0 || turnMessages.every((m) => m.role !== 'assistant')) {
    const fallbackMessage = buildAssistantMessageFromDeepagentsOutput(
      messageId,
      messageStartedAt,
      currentText,
      event.data?.output
    )
    turnMessages.push(fallbackMessage)
  }
  continue
}
```

- [ ] **Step 5: 重写 `on_tool_start` / `on_tool_end` — 仅处理内置工具**

将第 217-251 行替换为：

```typescript
// 内置工具事件：不在 ToolCatalog 中的工具（deepagents middleware 注入的 ls/read/write/edit/execute）
// 外部工具事件：由 executeDeepagentsToolCall 负责 emit，这里跳过
if (event.event === 'on_tool_start') {
  if (options.toolCatalog.getTool(event.name) !== undefined) {
    continue
  }
  const toolCallId = event.run_id
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
  if (options.toolCatalog.getTool(event.name) !== undefined) {
    continue
  }
  const toolCallId = event.run_id
  const invocation = builtinToolInvocations.get(toolCallId)
  if (invocation === undefined) {
    throw new TianjiError(
      'engine',
      'TOOL_EVENT_ORPHAN',
      `on_tool_end without matching on_tool_start: run_id=${toolCallId}`
    )
  }
  builtinToolInvocations.delete(toolCallId)

  // 内置工具的 tool-result 消息
  turnMessages.push({
    id: `msg_${randomUUID()}`,
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId,
      toolName: invocation.toolName,
      result: event.data?.output,
    }],
    createdAt: Date.now(),
  })

  options.emitEvent({
    type: 'tool.completed',
    runId: options.runId,
    toolCallId,
    invocation,
    result: {
      toolCallId,
      result: event.data?.output,
    },
    timestamp: Date.now(),
  })
  continue
}
```

- [ ] **Step 6: 运行类型检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: 可能有报错（后续步骤改 `DeepagentsRunResult` 后才能完全通过），先修复能修的。

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/engines/deepagents-engine.ts
git commit -m "refactor(deepagents-engine): restructure event loop with turnMessages and thinking capture"
```

---

### Task 5: `executeDeepagentsToolCall` 扩展 — 外部工具事件 + tool-result 消息

**Files:**
- Modify: `packages/runtime/src/engines/deepagents-engine.ts:380-497`

- [ ] **Step 1: 修改 `createDeepagentsTools` 传入 `turnMessages`**

将第 380-397 行中 `createDeepagentsTools` 的调用签名改为接收 `turnMessages`：

```typescript
function createDeepagentsTools(
  options: ExecuteDeepagentsRunOptions,
  observedToolCalls: DeepagentsPendingToolCall[],
  turnMessages: AppMessage[]
): DynamicStructuredTool[] {
  return options.toolCatalog.getToolSpecs().map(
    (spec) =>
      new DynamicStructuredTool({
        name: spec.name,
        description: spec.description,
        schema: spec.parameters,
        func: async (args) =>
          executeDeepagentsToolCall(options, observedToolCalls, turnMessages, {
            toolName: spec.name,
            args,
          }),
      })
  )
}
```

同时更新 `executeDeepagentsRun` 中调用 `createDeepagentsTools` 的位置（约第 169 行），传入 `turnMessages`：

```typescript
tools: createDeepagentsTools(options, observedToolCalls, turnMessages),
```

- [ ] **Step 2: 修改 `executeDeepagentsToolCall` 签名并添加事件 emit**

将 `executeDeepagentsToolCall` 函数签名改为：

```typescript
async function executeDeepagentsToolCall(
  options: ExecuteDeepagentsRunOptions,
  observedToolCalls: DeepagentsPendingToolCall[],
  turnMessages: AppMessage[],
  input: {
    readonly toolName: string
    readonly args: unknown
  }
): Promise<unknown> {
```

在 `const timestamp = Date.now()` 之后（约第 431 行），`try` 块之前，新增 `tool.started` 事件 emit：

```typescript
options.emitEvent({
  type: 'tool.started',
  runId: options.runId,
  toolCallId,
  invocation,
  timestamp,
})
```

- [ ] **Step 3: 在 `try` 块成功路径中添加 `tool.completed` 事件和 tool-result 消息**

在 `options.pendingOperations.set(...)` 之后（约第 457 行），`return result` 之前，添加：

```typescript
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

options.emitEvent({
  type: 'tool.completed',
  runId: options.runId,
  toolCallId,
  invocation,
  result: { toolCallId, result },
  timestamp: Date.now(),
})
```

- [ ] **Step 4: 在 `catch` 块中添加 tool-result 失败消息**

在现有的 `options.emitEvent({ type: 'tool.failed', ... })` 之前（约第 487 行），添加：

```typescript
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
```

- [ ] **Step 5: 运行类型检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: 可能还有 `DeepagentsRunResult` 相关报错，下一步修复。

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/engines/deepagents-engine.ts
git commit -m "feat(deepagents-engine): emit tool events from executeDeepagentsToolCall, build tool-result messages"
```

---

### Task 6: `DeepagentsRunResult` 改为 `turnMessages`，调整返回逻辑

**Files:**
- Modify: `packages/runtime/src/engines/deepagents-engine.ts:99-104`（接口）和 `254-282`（返回逻辑）

- [ ] **Step 1: 修改 `DeepagentsRunResult` 接口**

将：

```typescript
export interface DeepagentsRunResult {
  readonly finalMessage?: AppMessage
  readonly threadId: string
  readonly checkpointId?: string
  readonly interrupts?: readonly DeepagentsInterruptRecord[]
}
```

改为：

```typescript
export interface DeepagentsRunResult {
  readonly turnMessages: AppMessage[]
  readonly threadId: string
  readonly checkpointId?: string
  readonly interrupts?: readonly DeepagentsInterruptRecord[]
}
```

- [ ] **Step 2: 修改 `executeDeepagentsRun` 的返回逻辑**

将事件循环之后的返回部分（约第 254-282 行）改为：

```typescript
const stateSnapshot = await maybeReadDeepagentsStateSnapshot(agent, options, threadId)
const stateMetadata =
  stateSnapshot === undefined ? undefined : readDeepagentsStateMetadata(stateSnapshot, threadId)

if (stateMetadata !== undefined && stateMetadata.interrupts.length > 0) {
  return {
    turnMessages,
    threadId: stateMetadata.threadId,
    checkpointId: stateMetadata.checkpointId,
    interrupts: stateMetadata.interrupts,
  }
}

// 兜底：如果 on_chat_model_end 没触发，用剩余的 currentText 构建最终消息
if (currentText.length > 0 && turnMessages.every((m) => m.role !== 'assistant')) {
  turnMessages.push(
    buildAssistantMessage(messageId, messageStartedAt, currentText)
  )
}

const lastAssistantMessage = turnMessages.findLast((m) => m.role === 'assistant')

if (lastAssistantMessage !== undefined) {
  options.emitEvent({
    type: 'message.completed',
    runId: options.runId,
    messageId: lastAssistantMessage.id,
    message: lastAssistantMessage,
    timestamp: Date.now(),
  })
}

return {
  turnMessages,
  threadId: stateMetadata?.threadId ?? threadId,
  checkpointId: stateMetadata?.checkpointId,
}
```

- [ ] **Step 3: 运行类型检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: `runtime.ts` 中引用 `result.finalMessage` 的地方会报错，下一步修复。

- [ ] **Step 4: Commit**

```bash
git add packages/runtime/src/engines/deepagents-engine.ts
git commit -m "refactor(deepagents-engine): DeepagentsRunResult returns turnMessages instead of finalMessage"
```

---

### Task 7: runtime.ts 适配 `turnMessages`

**Files:**
- Modify: `packages/runtime/src/runtime.ts:551-618`（`executeRun` 方法中处理 result 的部分）

- [ ] **Step 1: 修改 `executeRun` 中处理 `result` 的逻辑**

将第 552-593 行：

```typescript
const result = await this.executeDeepagentsTurn(activeRun, input, context)
const finalMessage = result.finalMessage
// ...
if (finalMessage === undefined) {
  throw new ProviderError(
    'RUN_EMPTY_RESPONSE',
    'Runtime workflow finished without an assistant message'
  )
}

const nextSessionSnapshot: SessionSnapshot = {
  ...input.sessionSnapshot,
  messages: [...input.sessionSnapshot.messages, finalMessage],
  updatedAt: Date.now(),
}
```

改为：

```typescript
const result = await this.executeDeepagentsTurn(activeRun, input, context)
// ...（interrupts 处理逻辑保持不变）

if (result.turnMessages.length === 0) {
  throw new ProviderError(
    'RUN_EMPTY_RESPONSE',
    'Runtime workflow finished without any messages'
  )
}

const nextSessionSnapshot: SessionSnapshot = {
  ...input.sessionSnapshot,
  messages: [...input.sessionSnapshot.messages, ...result.turnMessages],
  updatedAt: Date.now(),
}
```

注意保持 interrupts 处理、`completedRunMetadata` 等逻辑不变，只改 `finalMessage` → `turnMessages` 的部分。

- [ ] **Step 2: 修改 `executeDeepagentsTurn` 返回类型**

`executeDeepagentsTurn` 方法（约第 672 行）的返回类型 `finalMessage?: AppMessage` 需要改为与 `DeepagentsRunResult` 一致。由于该方法直接 return `executeDeepagentsRun()` 的结果，类型会自动传播，只需更新方法签名上的类型注解。

- [ ] **Step 3: 运行类型检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add packages/runtime/src/runtime.ts
git commit -m "refactor(runtime): adapt to turnMessages from DeepagentsRunResult"
```

---

### Task 8: 日志完善

**Files:**
- Modify: `packages/runtime/src/runtime.ts:802-832`（`logToolEvent` 方法）
- Modify: `apps/node/src/task/task-executor.ts:213-230`（tool 事件日志）

- [ ] **Step 1: 补全 `runtime.ts` 的 `logToolEvent` 字段**

将 `logToolEvent` 方法（第 802-832 行）改为：

```typescript
private logToolEvent(
  event: ToolStartedEvent | ToolCompletedEvent | ToolFailedEvent,
  fields: RunLineageFields
): void {
  const logger = this.options.logger

  if (logger === undefined) {
    return
  }

  if (event.type === 'tool.started') {
    void logger.info(['runtime', 'tool'], 'tool.started', {
      sessionId: fields.sessionId,
      runId: fields.runId,
      toolCallId: event.toolCallId,
      toolName: event.invocation.toolName,
      args: event.invocation.args,
    })
  } else if (event.type === 'tool.completed') {
    void logger.info(['runtime', 'tool'], 'tool.completed', {
      sessionId: fields.sessionId,
      runId: fields.runId,
      toolCallId: event.toolCallId,
      toolName: event.invocation.toolName,
      result: event.result.result,
    })
  } else {
    void logger.error(['runtime', 'tool'], 'tool.failed', {
      sessionId: fields.sessionId,
      runId: fields.runId,
      toolCallId: event.toolCallId,
      toolName: event.invocation.toolName,
      args: event.invocation.args,
      errorCode: event.error.code,
      errorMessage: event.error.message,
    })
  }
}
```

- [ ] **Step 2: 新增 `logMessageEvent` 方法**

在 `logToolEvent` 方法之后添加：

```typescript
private logMessageEvent(
  event: MessageCompletedEvent,
  fields: RunLineageFields
): void {
  const logger = this.options.logger

  if (logger === undefined) {
    return
  }

  const hasThinking = event.message.content.some((p) => p.type === 'thinking')
  const hasToolCalls = event.message.content.some((p) => p.type === 'tool-call')
  const textParts = event.message.content
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)

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

需要在文件顶部 import 中添加 `MessageCompletedEvent`。

- [ ] **Step 3: 在 `emitEvent` 回调中调用 `logMessageEvent`**

在 `runtime.ts` 第 718-748 行的 `emitEvent` 回调中，在 tool 事件日志之后，添加：

```typescript
if (event.type === 'message.completed') {
  this.logMessageEvent(event as MessageCompletedEvent, lineage)
}
```

- [ ] **Step 4: 补全 `task-executor.ts` 的 tool 日志字段**

将第 213-230 行改为：

```typescript
} else if (event.type === 'tool.completed') {
  turn.toolCallCount += 1
  void logger?.logInfo(scope, 'Tool call completed', {
    taskId,
    runId: event.runId,
    toolCallId: event.toolCallId,
    toolCall: extractToolCallLabel(event),
    args: event.invocation.args,
    result: event.result.result,
  })
} else if (event.type === 'tool.failed') {
  turn.toolCallCount += 1
  void logger?.logError(scope, 'Tool call failed', {
    taskId,
    runId: event.runId,
    toolCallId: event.toolCallId,
    toolCall: extractToolCallLabel(event),
    args: event.invocation.args,
    errorCode: event.error.code,
    errorMessage: event.error.message,
  })
}
```

- [ ] **Step 5: 运行类型检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: 通过

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/runtime.ts apps/node/src/task/task-executor.ts
git commit -m "feat(runtime,task-executor): enrich tool and message logs with args, result, thinking"
```

---

### Task 9: 更新已有测试 + 新增测试

**Files:**
- Modify: `packages/runtime/src/__tests__/runtime.test.ts`

- [ ] **Step 1: 更新 "runs a single-turn" 测试适配 `turnMessages`**

该测试（第 32-128 行）当前断言 `sessionSnapshot?.messages` 长度为 2（user + assistant）。改为断言完整消息序列。`toolCallId` 应为 `'tool-1'`（外部工具，由 `resolveToolCallId` 匹配 LLM 的 `tool_call.id`）。

将 events 断言改为：

```typescript
expect(events.map((event) => event.type)).toEqual([
  'run.started',
  'message.started',
  'tool.started',
  'tool.completed',
  'message.completed',
  'run.completed',
])
```

将 toolCallId 断言保持不变：

```typescript
expect(toolStartedEvent?.toolCallId).toBe('tool-1')
expect(toolCompletedEvent?.toolCallId).toBe('tool-1')
```

将 session messages 断言改为：

```typescript
// user + assistant(tool-call) + tool(tool-result) + assistant(final text)
expect(sessionSnapshot?.messages).toHaveLength(4)
expect(sessionSnapshot?.messages[1]?.role).toBe('assistant')
expect(sessionSnapshot?.messages[1]?.content).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ type: 'tool-call', toolCallId: 'tool-1', toolName: 'sum' }),
  ])
)
expect(sessionSnapshot?.messages[2]?.role).toBe('tool')
expect(sessionSnapshot?.messages[2]?.content).toEqual([
  expect.objectContaining({
    type: 'tool-result',
    toolCallId: 'tool-1',
    toolName: 'sum',
    result: 3,
    isError: false,
  }),
])
expect(readTextContent(sessionSnapshot?.messages[3] ?? userMessage)).toBe('Calculating result 3')
```

- [ ] **Step 2: 运行测试验证绿灯**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && npx vitest run src/__tests__/runtime.test.ts -t "runs a single-turn" 2>&1`
Expected: PASS

- [ ] **Step 3: 新增 observer 日志 toolCallId 一致性测试**

在 `runtime.test.ts` 的 describe 块末尾新增：

```typescript
it('emits observer tool logs with consistent toolCallId across started and completed', async () => {
  const memorySink = createMemorySink()
  const toolRegistry = new ToolRegistry().registerTool({
    spec: {
      name: 'greet',
      description: 'Say hello',
      parameters: { type: 'object' },
    },
    execute: async () => 'hello',
    sideEffect: 'none',
  })

  const runtime = createSessionRuntime({
    deepagents: {
      model: fakeModel()
        .respondWithTools([{ name: 'greet', args: {}, id: 'greet-1' }])
        .respond(new AIMessage('Done')),
    },
    snapshotStore: new InMemorySnapshotStore(),
    toolCatalog: toolRegistry,
    logger: createObserverLogger({ sinks: [memorySink] }),
  })

  const session = await runtime.createSession({
    sessionId: createSessionId('session-tool-observer'),
  })
  const runId = await runtime.runTurn({
    sessionId: session.sessionId,
    message: createUserMessage('msg-tool-observer', 'greet me'),
  })
  await collectRuntimeEvents(runId, runtime)

  const toolLogEntries = memorySink.entries.filter(
    (entry: ObserverLogEntry): entry is ObserverLogEntry & { data: Record<string, unknown> } =>
      entry.scope.join('.') === 'runtime.tool'
  )
  const startedLog = toolLogEntries.find((entry) => entry.message === 'tool.started')
  const completedLog = toolLogEntries.find((entry) => entry.message === 'tool.completed')

  expect(startedLog).toBeDefined()
  expect(completedLog).toBeDefined()
  expect(startedLog?.data.toolCallId).toBe(completedLog?.data.toolCallId)
  expect(startedLog?.data.toolName).toBe('greet')
  expect(completedLog?.data.result).toBe('hello')
})
```

- [ ] **Step 4: 运行新测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && npx vitest run src/__tests__/runtime.test.ts -t "emits observer tool logs" 2>&1`
Expected: PASS

- [ ] **Step 5: 运行全部 runtime 测试回归**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && npx vitest run 2>&1`
Expected: 全部 PASS。如果其他测试因 messages 长度变化而失败，逐个更新断言。

- [ ] **Step 6: 最终类型检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: 通过

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/__tests__/runtime.test.ts
git commit -m "test(runtime): update tests for turnMessages, add observer tool log consistency test"
```

---

### Task 10: `serializeDeepagentsMessagePart` 兼容新类型

**Files:**
- Modify: `packages/runtime/src/engines/deepagents-engine.ts:565-582`

- [ ] **Step 1: 补全 `tool-result` 分支**

当前 `serializeDeepagentsMessagePart` 函数（第 565-582 行）处理 text/thinking/image/tool-call 四种类型。新增的 `ToolResultContent` 需要补全：

在 `return \`[tool-call ...]\`` 之前添加：

```typescript
if (part.type === 'tool-result') {
  const resultPreview = typeof part.result === 'string'
    ? part.result.slice(0, 200)
    : stableSerialize(part.result).slice(0, 200)
  return `[tool-result id=${part.toolCallId} name=${part.toolName} error=${part.isError ?? false} result=${resultPreview}]`
}
```

- [ ] **Step 2: 运行类型检查**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check`
Expected: 通过

- [ ] **Step 3: 运行全部 runtime 测试回归**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/runtime && npx vitest run 2>&1`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add packages/runtime/src/engines/deepagents-engine.ts
git commit -m "feat(deepagents-engine): serialize ToolResultContent in message parts"
```
