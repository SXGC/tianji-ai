/**
 * deepagents 流事件处理层。
 *
 * 负责将 deepagents/LangGraph 的流式事件分发到对应处理函数，并完成状态更新：
 * - on_chat_model_stream：文本增量累积与 delta 事件发射
 * - on_chat_model_end：消息打包与 token 用量记录
 * - LangGraph chain end：兜底消息构建
 * - on_tool_start / on_tool_end：内置工具事件转发
 */
import { randomUUID } from 'node:crypto'

import {
  type MessagePart,
  TianjiError,
  type TokenUsage,
  type ToolInvocation,
  addTokenUsage,
} from '@tianji/shared'

import { nextSequence } from './helpers.js'
import {
  buildAssistantMessageFromDeepagentsOutput,
  readChunkText,
  readChunkThinking,
  registerObservedToolCalls,
} from './message-serialization.js'
import type { DeepagentsAgentEvent, ExecuteDeepagentsRunOptions, StreamLoopState } from './types.js'

export function isLangGraphChainEnd(event: { event: string; name?: string }): boolean {
  return event.event === 'on_chain_end' && event.name === 'LangGraph'
}

/**
 * 从 LangChain AIMessage 的 usage_metadata 字段安全提取 token 用量。
 * LangChain 的 on_chat_model_end 事件中 data.output 是一个 AIMessage 实例，
 * 其 usage_metadata 包含 input_tokens、output_tokens、total_tokens。
 */
export function readUsageMetadata(output: unknown): TokenUsage | undefined {
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

/** 处理 on_chat_model_stream：累积文本和 thinking 增量并发射 delta 事件。 */
export function processChatModelStreamEvent(
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

/** 处理 on_chat_model_end：将累积内容打包为 turn message 并重置状态。 */
export function processChatModelEndEvent(
  state: StreamLoopState,
  event: DeepagentsAgentEvent
): void {
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
export function processChainEndEvent(state: StreamLoopState, event: DeepagentsAgentEvent): void {
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
export function processToolStartEvent(
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
  void options.logger?.info(['runtime', 'deepagents'], 'deepagents.builtin_tool.started', {
    sessionId: options.sessionId,
    runId: options.runId,
    toolCallId,
    toolName: invocation.toolName,
    args: invocation.args,
    backendConstructor: options.deepagents.backend?.constructor?.name,
    backendRootDir: readInspectableString(options.deepagents.backend, 'rootDir'),
    backendVirtualMode: readInspectableBoolean(options.deepagents.backend, 'virtualMode'),
    backendInheritEnv: readInspectableBoolean(options.deepagents.backend, 'inheritEnv'),
  })
  options.emitEvent({
    type: 'ToolStarted',
    runId: options.runId,
    toolCallId,
    invocation,
    timestamp: Date.now(),
  })
}

/** 处理 on_tool_end：为内置工具发射 completed 事件并记录 tool-result 消息。 */
export function processToolEndEvent(
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

  void options.logger?.info(['runtime', 'deepagents'], 'deepagents.builtin_tool.completed', {
    sessionId: options.sessionId,
    runId: options.runId,
    toolCallId,
    toolName: invocation.toolName,
    args: invocation.args,
    result: event.data?.output,
    backendConstructor: options.deepagents.backend?.constructor?.name,
    backendRootDir: readInspectableString(options.deepagents.backend, 'rootDir'),
    backendVirtualMode: readInspectableBoolean(options.deepagents.backend, 'virtualMode'),
    backendInheritEnv: readInspectableBoolean(options.deepagents.backend, 'inheritEnv'),
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
export function dispatchStreamEvent(
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

function readInspectableString(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null || typeof value !== 'object') {
    return undefined
  }

  const record = value as Record<string, unknown>
  return typeof record[key] === 'string' ? record[key] : undefined
}

function readInspectableBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined || value === null || typeof value !== 'object') {
    return undefined
  }

  const record = value as Record<string, unknown>
  return typeof record[key] === 'boolean' ? record[key] : undefined
}
