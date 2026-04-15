/**
 * deepagents 执行引擎适配层。
 *
 * 业务职责：
 * - 将 SessionRuntime 的消息、工具、取消与事件协议转换为 deepagents 所需格式。
 * - 统一处理流式文本、工具调用观测、checkpoint 状态回读与超时控制。
 * - 保持 @tianji/shared 定义的 DomainEvent / ToolResult / 错误语义稳定。
 *
 * 对外触点：
 * - 由 ../runtime.ts 在每次 runTurn/resumeRun 时调用 executeDeepagentsRun。
 * - 对接 deepagents createDeepAgent、@langchain/langgraph StateSnapshot、ToolCatalog。
 */
import { randomUUID } from 'node:crypto'

import { DynamicStructuredTool } from '@langchain/core/tools'
import { Command, type StateSnapshot } from '@langchain/langgraph'
import {
  type AppMessage,
  CancelledError,
  type DomainEvent,
  type ExecutionPolicy,
  type MessagePart,
  type MessageRole,
  type RunId,
  type RunSnapshot,
  type SessionId,
  TianjiError,
  TimeoutError,
  type TokenUsage,
  ToolError,
  type ToolInvocation,
  addTokenUsage,
} from '@tianji/shared'
import { createDeepAgent } from 'deepagents'

import type { ObserverLogger } from '@tianji/observer'
import type { LlmGenerationConfig } from '../llm/index.js'
import type { ToolCatalog } from '../tool-catalog.js'
import { ensureToolAllowed } from '../tool-catalog.js'

import { LlmCallRecorder, createRecordingMiddleware } from '../llm-call-recorder.js'
import { LlmRawStore } from '../llm-raw-store.js'
import type { SessionRuntimeDeepagentsConfig } from '../types.js'
import type {
  AbortSignalScope,
  DeepAgentFactory,
  DeepagentsAgentEvent,
  DeepagentsAgentInstance,
  DeepagentsInterruptRecord,
  DeepagentsPendingToolCall,
  DeepagentsRunResult,
  ExecuteDeepagentsRunOptions,
  StreamLoopState,
} from './deepagents/types.js'

export type { DeepagentsRunResult } from './deepagents/types.js'

import {
  createAbortSignalScope,
  executeWithTimeout,
  isCancellationError,
  isRecord,
  nextSequence,
  resolveToolError,
  stableSerialize,
  toError,
} from './deepagents/helpers.js'
import {
  buildAssistantMessage,
  buildAssistantMessageFromDeepagentsOutput,
  convertAppMessageToDeepagentsMessage,
  parseToolArgs,
  readChunkText,
  readChunkThinking,
  readObservedToolCalls,
} from './deepagents/message-serialization.js'

function isLangGraphChainEnd(event: { event: string; name?: string }): boolean {
  return event.event === 'on_chain_end' && event.name === 'LangGraph'
}

/** 处理 on_chat_model_stream：累积文本和 thinking 增量并发射 delta 事件。 */
function processChatModelStreamEvent(
  state: StreamLoopState,
  event: DeepagentsAgentEvent,
  options: ExecuteDeepagentsRunOptions
): void {
  const text = readChunkText(event.data?.chunk)
  if (text.length > 0) {
    state.currentText += text
    options.emitEvent({
      type: 'MessageDelta',
      runId: options.runId,
      messageId: state.messageId,
      sequence: nextSequence(options.sequence),
      channel: 'text',
      payload: { content: text },
      timestamp: Date.now(),
    })
  }

  const thinking = readChunkThinking(event.data?.chunk)
  if (thinking.length > 0) {
    state.currentThinking += thinking
    options.emitEvent({
      type: 'MessageDelta',
      runId: options.runId,
      messageId: state.messageId,
      sequence: nextSequence(options.sequence),
      channel: 'thinking',
      payload: { content: thinking },
      timestamp: Date.now(),
    })
  }

  registerObservedToolCalls(event.data?.chunk, state.observedToolCalls)
}

/**
 * 从 LangChain AIMessage 的 usage_metadata 字段安全提取 token 用量。
 * LangChain 的 on_chat_model_end 事件中 data.output 是一个 AIMessage 实例，
 * 其 usage_metadata 包含 input_tokens、output_tokens、total_tokens。
 */
function readUsageMetadata(output: unknown): TokenUsage | undefined {
  if (typeof output !== 'object' || output === null) {
    return undefined
  }

  const candidate = output as { usage_metadata?: unknown }
  const metadata = candidate.usage_metadata

  if (typeof metadata !== 'object' || metadata === null) {
    return undefined
  }

  const typed = metadata as {
    input_tokens?: unknown
    output_tokens?: unknown
    total_tokens?: unknown
    input_token_details?: { cache_read?: unknown; cache_creation?: unknown }
  }

  if (
    typeof typed.input_tokens !== 'number' ||
    typeof typed.output_tokens !== 'number' ||
    typeof typed.total_tokens !== 'number'
  ) {
    return undefined
  }

  const details = typed.input_token_details
  const cacheRead = typeof details?.cache_read === 'number' ? details.cache_read : undefined
  const cacheCreation =
    typeof details?.cache_creation === 'number' ? details.cache_creation : undefined

  return {
    inputTokens: typed.input_tokens,
    outputTokens: typed.output_tokens,
    totalTokens: typed.total_tokens,
    ...(cacheRead !== undefined && { cacheReadTokens: cacheRead }),
    ...(cacheCreation !== undefined && { cacheCreationTokens: cacheCreation }),
  }
}

/** 处理 on_chat_model_end：将累积内容打包为 turn message 并重置状态。 */
function processChatModelEndEvent(state: StreamLoopState, event: DeepagentsAgentEvent): void {
  registerObservedToolCalls(event.data?.output, state.observedToolCalls)

  // 从 AIMessage.usage_metadata 提取 token 用量并累加到 run 级别计数器。
  const usageMetadata = readUsageMetadata(event.data?.output)
  if (usageMetadata !== undefined) {
    state.usage = addTokenUsage(state.usage, usageMetadata)
  }

  const parts: MessagePart[] = []
  if (state.currentThinking.length > 0) {
    parts.push({ type: 'thinking', thinking: state.currentThinking })
  }
  if (state.currentText.length > 0) {
    parts.push({ type: 'text', text: state.currentText })
  }
  for (const tc of state.observedToolCalls.filter((c) => !c.consumed)) {
    parts.push({
      type: 'tool-call',
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      args: tc.args,
    })
  }

  if (parts.length > 0) {
    state.turnMessages.push({
      id: `msg_${randomUUID()}`,
      role: 'assistant',
      content: parts,
      createdAt: Date.now(),
    })
  }

  state.currentThinking = ''
  state.currentText = ''
}

/** 处理 LangGraph chain end：当 on_chat_model_end 未触发时从 output 构建兜底消息。 */
function processChainEndEvent(state: StreamLoopState, event: DeepagentsAgentEvent): void {
  const hasAssistantWithText = state.turnMessages.some(
    (m) => m.role === 'assistant' && m.content.some((p) => p.type === 'text')
  )
  if (!hasAssistantWithText) {
    const fallbackMessage = buildAssistantMessageFromDeepagentsOutput(
      state.messageId,
      state.messageStartedAt,
      state.currentText,
      event.data?.output
    )
    state.turnMessages.push(fallbackMessage)
  }
}

/** 处理 on_tool_start：为内置工具（非 ToolCatalog 中的工具）发射 started 事件。 */
function processToolStartEvent(
  state: StreamLoopState,
  event: DeepagentsAgentEvent,
  options: ExecuteDeepagentsRunOptions
): void {
  if (options.toolCatalog.getTool(event.name) !== undefined) {
    return
  }
  const toolCallId = event.run_id
  const invocation: ToolInvocation = {
    toolCallId,
    toolName: event.name,
    args: (event.data?.input ?? {}) as Record<string, unknown>,
  }
  state.builtinToolInvocations.set(toolCallId, invocation)
  options.emitEvent({
    type: 'ToolStarted',
    runId: options.runId,
    toolCallId,
    invocation,
    timestamp: Date.now(),
  })
}

/** 处理 on_tool_end：为内置工具发射 completed 事件并记录 tool-result 消息。 */
function processToolEndEvent(
  state: StreamLoopState,
  event: DeepagentsAgentEvent,
  options: ExecuteDeepagentsRunOptions
): void {
  if (options.toolCatalog.getTool(event.name) !== undefined) {
    return
  }
  const toolCallId = event.run_id
  const invocation = state.builtinToolInvocations.get(toolCallId)
  if (invocation === undefined) {
    throw new TianjiError(
      'internal',
      'TOOL_EVENT_ORPHAN',
      `on_tool_end without matching on_tool_start: run_id=${toolCallId}`
    )
  }
  state.builtinToolInvocations.delete(toolCallId)

  state.turnMessages.push({
    id: `msg_${randomUUID()}`,
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName: invocation.toolName,
        result: event.data?.output,
      },
    ],
    createdAt: Date.now(),
  })

  options.emitEvent({
    type: 'ToolCompleted',
    runId: options.runId,
    toolCallId,
    invocation,
    result: {
      toolCallId,
      result: event.data?.output,
    },
    timestamp: Date.now(),
  })
}

/**
 * 将单个流式事件分发到对应的处理函数。
 *
 * 从 {@link executeDeepagentsRun} 的事件循环中提取，负责根据事件类型将
 * `on_chat_model_stream`、`on_chat_model_end`、LangGraph chain end、
 * `on_tool_start`、`on_tool_end` 路由到各自的处理器。
 */
function dispatchStreamEvent(
  loopState: StreamLoopState,
  event: DeepagentsAgentEvent,
  options: ExecuteDeepagentsRunOptions
): void {
  if (event.event === 'on_chat_model_stream') {
    processChatModelStreamEvent(loopState, event, options)
    return
  }
  if (event.event === 'on_chat_model_end') {
    processChatModelEndEvent(loopState, event)
    return
  }
  if (isLangGraphChainEnd(event)) {
    processChainEndEvent(loopState, event)
    return
  }
  if (event.event === 'on_tool_start') {
    processToolStartEvent(loopState, event, options)
    return
  }
  if (event.event === 'on_tool_end') {
    processToolEndEvent(loopState, event, options)
  }
}

/**
 * 执行一次 deepagents 运行并将其完整映射为 DomainEvent / RunResult。
 *
 * 处理流程：
 * 1. 校验运行配置并初始化 assistant 消息占位。
 * 2. 创建 deepagents agent，并把运行时工具目录包装为 deepagents tools。
 * 3. 消费流式事件，持续转发文本增量，同时记录模型侧观测到的工具调用。
 * 4. 在运行结束后读取 checkpoint 状态，识别 interrupt / checkpoint 元数据。
 * 5. 若存在 interrupt，则返回恢复所需信息；否则产出最终 assistant 消息。
 */
export async function executeDeepagentsRun(
  options: ExecuteDeepagentsRunOptions
): Promise<DeepagentsRunResult> {
  // 这里再次守卫 deepagents.model，避免绕过 runtime 构造阶段后进入不完整执行状态。
  if (!hasDeepagentsModel(options.deepagents.model)) {
    throw new TianjiError(
      'state',
      'INVALID_DEEPAGENTS_CONFIG',
      'deepagents.model is required when engine is set to deepagents'
    )
  }

  const messageId = `msg_${randomUUID()}`
  const messageStartedAt = Date.now()
  const initialMessage: AppMessage = {
    id: messageId,
    role: 'assistant',
    content: [],
    createdAt: messageStartedAt,
  }
  const observedToolCalls: DeepagentsPendingToolCall[] = []
  const turnMessages: AppMessage[] = []
  let currentText = ''
  const builtinToolInvocations = new Map<string, ToolInvocation>()
  const threadId = options.threadId ?? options.sessionId
  const createUntypedDeepAgent = createDeepAgent as unknown as DeepAgentFactory

  const llmRecorder = options.llmRawDir === undefined ? undefined : new LlmCallRecorder()
  const recordingMiddleware =
    llmRecorder === undefined ? undefined : createRecordingMiddleware(llmRecorder)

  options.emitEvent({
    type: 'MessageStarted',
    runId: options.runId,
    messageId,
    message: initialMessage,
    timestamp: messageStartedAt,
  })

  const agent = createUntypedDeepAgent({
    model: options.deepagents.model,
    systemPrompt: options.systemPrompt,
    middleware: buildMiddlewareList(options.deepagents.middleware, recordingMiddleware),
    subagents: resolveDeepagentsSubagents(options.deepagents.subagents),
    checkpointer: resolveDeepagentsCheckpointer(options.deepagents.checkpointer),
    store: resolveDeepagentsStore(options.deepagents.store),
    backend: resolveDeepagentsBackend(options.deepagents.backend),
    interruptOn: resolveDeepagentsInterruptOn(options.deepagents.interruptOn),
    skills: options.deepagents.skills ? [...options.deepagents.skills] : undefined,
    tools: createDeepagentsTools(options, observedToolCalls, turnMessages),
  })

  const events = await agent.streamEvents(readDeepagentsInput(options), {
    version: 'v2',
    configurable: {
      thread_id: threadId,
      checkpoint_id: options.checkpointId,
    },
    signal: options.signal,
  })

  const loopState: StreamLoopState = {
    messageId,
    messageStartedAt,
    observedToolCalls,
    turnMessages,
    builtinToolInvocations,
    currentThinking: '',
    currentText: '',
    usage: undefined,
  }

  try {
    for await (const event of events) {
      dispatchStreamEvent(loopState, event, options)
    }
  } finally {
    await persistLlmRaw(options, llmRecorder)
  }

  currentText = loopState.currentText

  const stateSnapshot = await maybeReadDeepagentsStateSnapshot(agent, options, threadId)
  const stateMetadata =
    stateSnapshot === undefined ? undefined : readDeepagentsStateMetadata(stateSnapshot, threadId)

  if (stateMetadata !== undefined && stateMetadata.interrupts.length > 0) {
    return {
      turnMessages,
      threadId: stateMetadata.threadId,
      checkpointId: stateMetadata.checkpointId,
      interrupts: stateMetadata.interrupts,
      usage: loopState.usage,
    }
  }

  // 兜底：如果 on_chat_model_end 没触发，用剩余的 currentText 构建最终消息
  if (currentText.length > 0 && turnMessages.every((m) => m.role !== 'assistant')) {
    turnMessages.push(buildAssistantMessage(messageId, messageStartedAt, currentText))
  }

  const lastAssistantMessage = [...turnMessages]
    .reverse()
    .find((m: AppMessage) => m.role === 'assistant')

  if (lastAssistantMessage !== undefined) {
    options.emitEvent({
      type: 'MessageCompleted',
      runId: options.runId,
      messageId,
      message: lastAssistantMessage,
      timestamp: Date.now(),
    })
  }

  return {
    turnMessages,
    threadId: stateMetadata?.threadId ?? threadId,
    checkpointId: stateMetadata?.checkpointId,
    usage: loopState.usage,
  }
}

/**
 * 将一次运行请求转换为 deepagents 可接受的输入。
 * 恢复执行时优先构造 Command.resume；普通执行则把历史消息序列转换为 deepagents messages。
 */
function readDeepagentsInput(options: ExecuteDeepagentsRunOptions): unknown {
  if (options.resumeValue !== undefined) {
    return new Command({ resume: options.resumeValue })
  }

  return {
    // tool role 消息仅用于快照持久化，不回传给 LangGraph（LangGraph 通过内部状态管理工具调用历史）
    messages: options.messages
      .filter((m) => m.role !== 'tool')
      .map(convertAppMessageToDeepagentsMessage),
  }
}

/**
 * 在启用 checkpointer 时回读 deepagents 状态快照，用于提取 checkpoint 与 interrupt 信息。
 */
async function maybeReadDeepagentsStateSnapshot(
  agent: DeepagentsAgentInstance,
  options: ExecuteDeepagentsRunOptions,
  threadId: string
): Promise<StateSnapshot | undefined> {
  if (!hasConfiguredDeepagentsCheckpointer(options.deepagents.checkpointer)) {
    return undefined
  }

  return agent.getState({
    configurable: {
      thread_id: threadId,
    },
  })
}

/**
 * 从 LangGraph 状态快照中提取运行恢复所需的 thread_id、checkpoint_id 与 interrupt 列表。
 * 这里会容错 deepagents 返回的松散结构，统一回落到运行时可消费的稳定元数据格式。
 */
function readDeepagentsStateMetadata(
  snapshot: StateSnapshot,
  fallbackThreadId: string
): {
  readonly threadId: string
  readonly checkpointId?: string
  readonly interrupts: readonly DeepagentsInterruptRecord[]
} {
  const configurable = readConfigurableState(snapshot.config)
  const interrupts = snapshot.tasks.flatMap((task) =>
    task.interrupts
      .filter(isDeepagentsInterruptRecord)
      .map((interrupt) => ({ id: interrupt.id, value: interrupt.value }))
  )

  return {
    threadId:
      typeof configurable?.thread_id === 'string' && configurable.thread_id.length > 0
        ? configurable.thread_id
        : fallbackThreadId,
    checkpointId:
      typeof configurable?.checkpoint_id === 'string' && configurable.checkpoint_id.length > 0
        ? configurable.checkpoint_id
        : undefined,
    interrupts,
  }
}

/**
 * 读取 StateSnapshot.config.configurable；结构不符合预期时返回 undefined。
 */
function readConfigurableState(
  config: StateSnapshot['config']
): Record<string, unknown> | undefined {
  if (!isRecord(config) || !isRecord(config.configurable)) {
    return undefined
  }

  return config.configurable
}

/**
 * 判断某个 interrupt 记录是否满足 runtime 侧可接受的最小结构。
 */
function isDeepagentsInterruptRecord(value: unknown): value is DeepagentsInterruptRecord {
  if (!isRecord(value)) {
    return false
  }

  return (
    (value.id === undefined || typeof value.id === 'string') &&
    ('value' in value || value.value === undefined)
  )
}

/**
 * 根据运行时工具目录创建 deepagents 工具列表。
 * 每个 deepagents tool 最终都会回流到 runtime 的 executeTool 流程，以复用统一的权限、超时、取消和事件分发逻辑。
 */
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

/**
 * 执行一次来自 deepagents 的工具调用，并把运行时事件、挂起状态与错误语义同步到平台侧。
 *
 * 关键职责：
 * - 校验工具是否存在且是否允许执行破坏性操作。
 * - 结合模型流式观测结果复用 toolCallId，保证事件与快照中的工具调用可关联。
 * - 在统一超时/取消控制下执行工具，并维护 pendingOperations 的状态迁移。
 * - 将原始错误归一化为 contracts 中定义的 ToolError / CancelledError / TimeoutError。
 */
async function executeDeepagentsToolCall(
  options: ExecuteDeepagentsRunOptions,
  observedToolCalls: DeepagentsPendingToolCall[],
  turnMessages: AppMessage[],
  input: {
    readonly toolName: string
    readonly args: unknown
  }
): Promise<unknown> {
  // 先从运行时工具目录解析定义，保证 deepagents 工具调用仍受平台侧策略和上下文控制。
  const definition = options.toolCatalog.getTool(input.toolName)

  if (definition === undefined) {
    throw new ToolError('TOOL_NOT_FOUND', `Tool "${input.toolName}" is not registered`)
  }

  ensureToolAllowed(definition, options.policy.tool.allowDestructive)

  const toolCallId = resolveToolCallId(observedToolCalls, input.toolName, input.args)
  const invocation: ToolInvocation = {
    toolCallId,
    toolName: input.toolName,
    args: input.args,
  }
  const timestamp = Date.now()

  options.emitEvent({
    type: 'ToolStarted',
    runId: options.runId,
    toolCallId,
    invocation,
    timestamp,
  })

  options.pendingOperations.set(toolCallId, {
    id: toolCallId,
    invocation,
    status: 'running',
    timestamp,
  })

  try {
    const result = await executeWithTimeout(
      (abortSignal) =>
        options.toolCatalog.executeTool(invocation, {
          sessionId: options.sessionId,
          runId: options.runId,
          toolCallId,
          abortSignal,
        }),
      options.policy.tool.timeoutMs,
      options.signal
    )
    options.pendingOperations.set(toolCallId, {
      id: toolCallId,
      invocation,
      status: 'completed',
      timestamp,
    })

    if (definition.sideEffect === 'destructive') {
      options.destructiveOperationIds.add(toolCallId)
    }

    turnMessages.push({
      id: `msg_${randomUUID()}`,
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: input.toolName,
          result,
          isError: false,
        },
      ],
      createdAt: Date.now(),
    })

    options.emitEvent({
      type: 'ToolCompleted',
      runId: options.runId,
      toolCallId,
      invocation,
      result: { toolCallId, result },
      timestamp: Date.now(),
    })

    return result
  } catch (error) {
    if (isCancellationError(error, options.signal)) {
      options.pendingOperations.set(toolCallId, {
        id: toolCallId,
        invocation,
        status:
          definition.sideEffect === 'destructive' ? 'aborted-with-side-effect' : 'aborted-clean',
        timestamp,
      })
      throw new CancelledError('RUN_CANCELLED', 'Run cancelled during tool execution', {
        cause: toError(error),
      })
    }

    const resolvedError = resolveToolError(error)

    options.pendingOperations.set(toolCallId, {
      id: toolCallId,
      invocation,
      status:
        definition.sideEffect === 'destructive' ? 'aborted-with-side-effect' : 'aborted-clean',
      timestamp,
    })
    turnMessages.push({
      id: `msg_${randomUUID()}`,
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: input.toolName,
          result: resolvedError.message,
          isError: true,
        },
      ],
      createdAt: Date.now(),
    })

    options.emitEvent({
      type: 'ToolFailed',
      runId: options.runId,
      toolCallId,
      invocation,
      error: resolvedError,
      timestamp: Date.now(),
    })
    throw resolvedError
  }
}

/**
 * 合并模型流式阶段观测到的工具调用片段，逐步补全参数文本并生成可比较的参数对象。
 */
function registerObservedToolCalls(
  chunk: unknown,
  observedToolCalls: DeepagentsPendingToolCall[]
): void {
  for (const observedToolCall of readObservedToolCalls(chunk)) {
    const existing = observedToolCalls.find(
      (item) => item.toolCallId === observedToolCall.toolCallId
    )

    if (existing !== undefined) {
      const mergedArgsText = `${existing.argsText}${observedToolCall.argsText}`
      observedToolCalls.splice(observedToolCalls.indexOf(existing), 1, {
        ...existing,
        argsText: mergedArgsText,
        args: parseToolArgs(mergedArgsText),
      })
      continue
    }

    observedToolCalls.push(observedToolCall)
  }
}

/**
 * 优先复用模型侧已观测到的 toolCallId；匹配失败时退化为生成本地 ID。
 */
function resolveToolCallId(
  observedToolCalls: DeepagentsPendingToolCall[],
  toolName: string,
  args: unknown
): string {
  const comparableArgs = stableSerialize(args)
  const matched = observedToolCalls.find(
    (toolCall) =>
      !toolCall.consumed &&
      toolCall.toolName === toolName &&
      stableSerialize(toolCall.args) === comparableArgs
  )

  if (matched !== undefined) {
    matched.consumed = true
    return matched.toolCallId
  }

  return `tool_${randomUUID()}`
}

/**
 * 解析 checkpointer 配置，占位配置或无效值时返回 undefined。
 */
function resolveDeepagentsCheckpointer(value: SessionRuntimeDeepagentsConfig['checkpointer']) {
  if (value === undefined || typeof value === 'boolean') {
    return value
  }

  if (isPlaceholderConfig(value)) {
    return undefined
  }

  return value
}

/**
 * 当数组有效且非空时返回其浅拷贝，否则返回 undefined。
 * 用于统一处理 middleware / subagents 等可选数组配置，避免共享可变引用。
 */
function resolveOptionalArray<T>(value: readonly T[] | undefined): T[] | undefined {
  if (value === undefined || value.length === 0) {
    return undefined
  }

  return [...value]
}

/**
 * 解析 middleware 配置并复制数组，避免调用方后续修改原始引用。
 */
function resolveDeepagentsMiddleware(value: SessionRuntimeDeepagentsConfig['middleware']) {
  return resolveOptionalArray(value)
}

/**
 * 将用户 middleware 与录制 middleware 合并。
 * 录制 middleware 放在末尾，确保录到的是最终发给模型的请求。
 */
function buildMiddlewareList(
  userMiddleware: SessionRuntimeDeepagentsConfig['middleware'],
  recordingMiddleware: unknown
): unknown[] | undefined {
  const user = resolveDeepagentsMiddleware(userMiddleware)
  if (recordingMiddleware === undefined) {
    return user
  }
  if (user !== undefined) {
    return [...user, recordingMiddleware]
  }
  return [recordingMiddleware]
}

/**
 * 将本次 runTurn 的 LLM 调用记录持久化到 raws/ 目录。
 * 只在配置了 llmRawDir 且有调用记录时才写文件。
 * 持久化失败不阻断主流程，只记录 error 日志。
 */
async function persistLlmRaw(
  options: ExecuteDeepagentsRunOptions,
  recorder: LlmCallRecorder | undefined
): Promise<void> {
  if (recorder === undefined) return

  const record = recorder.toRecord(options.runId, options.sessionId)
  if (record.calls.length === 0) return

  const store = new LlmRawStore(options.llmRawDir!)
  try {
    await store.write(record)
  } catch (error) {
    options.logger?.error(
      ['runtime', 'llm-raw'],
      `failed to persist LLM raw record for run ${options.runId}`,
      { error }
    )
  }
}

/**
 * 解析 subagents 配置并复制数组，避免共享可变引用。
 */
function resolveDeepagentsSubagents(value: SessionRuntimeDeepagentsConfig['subagents']) {
  return resolveOptionalArray(value)
}

/**
 * 解析 store 配置，占位配置时返回 undefined。
 */
function resolveDeepagentsStore(value: SessionRuntimeDeepagentsConfig['store']) {
  if (value === undefined || isPlaceholderConfig(value)) {
    return undefined
  }

  return value
}

/**
 * 解析 backend 配置，过滤 null / 占位配置。
 */
function resolveDeepagentsBackend(value: SessionRuntimeDeepagentsConfig['backend']) {
  if (value === undefined || value === null || isPlaceholderConfig(value)) {
    return undefined
  }

  return value
}

/**
 * 深拷贝 interruptOn 配置，避免 deepagents 在运行期间修改调用方传入对象。
 */
function resolveDeepagentsInterruptOn(value: SessionRuntimeDeepagentsConfig['interruptOn']) {
  if (value === undefined) {
    return undefined
  }

  return Object.fromEntries(
    Object.entries(value).map(([toolName, config]) => {
      if (typeof config === 'boolean') {
        return [toolName, config]
      }

      return [
        toolName,
        {
          ...config,
          allowedDecisions: [...config.allowedDecisions],
        },
      ]
    })
  )
}

/**
 * 判断配置对象是否为 runtime 内部占位标记。
 */
function isPlaceholderConfig(value: unknown): value is { readonly kind: string } {
  return isRecord(value) && typeof value.kind === 'string'
}

/**
 * 判断 deepagents.model 是否已配置。
 */
function hasDeepagentsModel(value: SessionRuntimeDeepagentsConfig['model']): boolean {
  if (typeof value === 'string') {
    return value.length > 0
  }

  return value !== undefined
}

/**
 * 判断当前运行是否启用了可读取状态的 checkpointer。
 */
function hasConfiguredDeepagentsCheckpointer(
  value: SessionRuntimeDeepagentsConfig['checkpointer']
): boolean {
  return value !== undefined && value !== false
}
