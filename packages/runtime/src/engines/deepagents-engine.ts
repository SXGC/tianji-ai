/**
 * deepagents 执行引擎适配层。
 *
 * 业务职责：
 * - 将 SessionRuntime 的消息、工具、取消与事件协议转换为 deepagents 所需格式。
 * - 统一处理流式文本、工具调用观测、checkpoint 状态回读与超时控制。
 * - 保持 @tianji/contracts 定义的 RuntimeEvent / ToolResult / 错误语义稳定。
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
  type ExecutionPolicy,
  type RunId,
  type RunSnapshot,
  type RuntimeEvent,
  type SessionId,
  TianjiError,
  TimeoutError,
  ToolError,
  type ToolInvocation,
  type ToolResult,
} from '@tianji/contracts'
import type { LlmGenerationConfig } from '@tianji/llm'
import { createDeepAgent } from 'deepagents'

import type { SessionRuntimeDeepagentsConfig } from '../runtime.js'
import type { ToolCatalog } from '../tool-catalog.js'
import { ensureToolAllowed } from '../tool-catalog.js'

interface DeepagentsPendingToolCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly argsText: string
  readonly args: unknown
  consumed: boolean
}

interface ExecuteDeepagentsRunOptions {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly messages: readonly AppMessage[]
  readonly signal: AbortSignal
  readonly policy: ExecutionPolicy
  readonly config?: LlmGenerationConfig
  readonly systemPrompt?: string
  readonly threadId?: string
  readonly checkpointId?: string
  readonly resumeValue?: unknown
  readonly deepagents: SessionRuntimeDeepagentsConfig
  readonly toolCatalog: ToolCatalog
  readonly pendingOperations: Map<string, RunSnapshot['pendingOperations'][number]>
  readonly destructiveOperationIds: Set<string>
  readonly sequence: {
    current: number
  }
  readonly emitEvent: (event: RuntimeEvent) => void
}

type DeepAgentFactory = (params?: Record<string, unknown>) => DeepagentsAgentInstance

interface DeepagentsAgentEvent {
  readonly event: string
  readonly name: string
  readonly data?: Record<string, unknown>
}

interface DeepagentsAgentInstance {
  readonly streamEvents: (
    input: unknown,
    options: {
      readonly version: 'v2'
      readonly configurable: {
        readonly thread_id: string
        readonly checkpoint_id?: string
      }
      readonly signal: AbortSignal
    }
  ) => Promise<AsyncIterable<DeepagentsAgentEvent>>
  readonly getState: (options: {
    readonly configurable: {
      readonly thread_id: string
      readonly checkpoint_id?: string
    }
  }) => Promise<StateSnapshot>
}

interface DeepagentsInterruptRecord {
  readonly id?: string
  readonly value?: unknown
}

export interface DeepagentsRunResult {
  readonly finalMessage?: AppMessage
  readonly threadId: string
  readonly checkpointId?: string
  readonly interrupts?: readonly DeepagentsInterruptRecord[]
}

interface AbortSignalScope {
  readonly signal: AbortSignal | undefined
  readonly cleanup: () => void
}

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
  let aggregatedText = ''
  let finalMessage: AppMessage | undefined
  const threadId = options.threadId ?? options.sessionId
  const createUntypedDeepAgent = createDeepAgent as unknown as DeepAgentFactory

  options.emitEvent({
    type: 'message.started',
    runId: options.runId,
    messageId,
    message: initialMessage,
    timestamp: messageStartedAt,
  })

  const agent = createUntypedDeepAgent({
    model: options.deepagents.model,
    systemPrompt: options.systemPrompt,
    middleware: resolveDeepagentsMiddleware(options.deepagents.middleware),
    subagents: resolveDeepagentsSubagents(options.deepagents.subagents),
    checkpointer: resolveDeepagentsCheckpointer(options.deepagents.checkpointer),
    store: resolveDeepagentsStore(options.deepagents.store),
    backend: resolveDeepagentsBackend(options.deepagents.backend),
    interruptOn: resolveDeepagentsInterruptOn(options.deepagents.interruptOn),
    skills: options.deepagents.skills ? [...options.deepagents.skills] : undefined,
    tools: createDeepagentsTools(options, observedToolCalls),
  })

  const events = await agent.streamEvents(readDeepagentsInput(options), {
    version: 'v2',
    configurable: {
      thread_id: threadId,
      checkpoint_id: options.checkpointId,
    },
    signal: options.signal,
  })

  for await (const event of events) {
    if (event.event === 'on_chat_model_stream') {
      const content = readChunkText(event.data?.chunk)

      if (content.length > 0) {
        aggregatedText += content
        options.emitEvent({
          type: 'message.delta',
          runId: options.runId,
          messageId,
          sequence: nextSequence(options.sequence),
          channel: 'text',
          payload: { content },
          timestamp: Date.now(),
        })
      }

      registerObservedToolCalls(event.data?.chunk, observedToolCalls)
      continue
    }

    if (event.event === 'on_chat_model_end') {
      registerObservedToolCalls(event.data?.output, observedToolCalls)
      continue
    }

    if (event.event === 'on_chain_end' && event.name === 'LangGraph') {
      finalMessage = buildAssistantMessageFromDeepagentsOutput(
        messageId,
        messageStartedAt,
        aggregatedText,
        event.data?.output
      )
    }
  }

  const stateSnapshot = await maybeReadDeepagentsStateSnapshot(agent, options, threadId)
  const stateMetadata =
    stateSnapshot === undefined ? undefined : readDeepagentsStateMetadata(stateSnapshot, threadId)

  if (stateMetadata !== undefined && stateMetadata.interrupts.length > 0) {
    return {
      threadId: stateMetadata.threadId,
      checkpointId: stateMetadata.checkpointId,
      interrupts: stateMetadata.interrupts,
    }
  }

  const completedMessage =
    finalMessage ?? buildAssistantMessage(messageId, messageStartedAt, aggregatedText)

  options.emitEvent({
    type: 'message.completed',
    runId: options.runId,
    messageId,
    message: completedMessage,
    timestamp: Date.now(),
  })

  return {
    finalMessage: completedMessage,
    threadId: stateMetadata?.threadId ?? threadId,
    checkpointId: stateMetadata?.checkpointId,
  }
}

function readDeepagentsInput(options: ExecuteDeepagentsRunOptions): unknown {
  if (options.resumeValue !== undefined) {
    return new Command({ resume: options.resumeValue })
  }

  return {
    messages: options.messages.map(convertAppMessageToDeepagentsMessage),
  }
}

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

function readConfigurableState(
  config: StateSnapshot['config']
): Record<string, unknown> | undefined {
  if (!isRecord(config) || !isRecord(config.configurable)) {
    return undefined
  }

  return config.configurable
}

function isDeepagentsInterruptRecord(value: unknown): value is DeepagentsInterruptRecord {
  if (!isRecord(value)) {
    return false
  }

  return (
    (value.id === undefined || typeof value.id === 'string') &&
    ('value' in value || value.value === undefined)
  )
}

function createDeepagentsTools(
  options: ExecuteDeepagentsRunOptions,
  observedToolCalls: DeepagentsPendingToolCall[]
): DynamicStructuredTool[] {
  return options.toolCatalog.getToolSpecs().map(
    (spec) =>
      new DynamicStructuredTool({
        name: spec.name,
        description: spec.description,
        schema: spec.parameters,
        func: async (args) =>
          executeDeepagentsToolCall(options, observedToolCalls, {
            toolName: spec.name,
            args,
          }),
      })
  )
}

async function executeDeepagentsToolCall(
  options: ExecuteDeepagentsRunOptions,
  observedToolCalls: DeepagentsPendingToolCall[],
  input: {
    readonly toolName: string
    readonly args: unknown
  }
): Promise<unknown> {
  // 先从运行时工具目录解析定义，保证 deepagents 工具调用仍受平台侧策略和上下文控制。
  const definition = options.toolCatalog.getTool(input.toolName)

  if (definition === undefined) {
    throw new ToolError('TOOL_NOT_FOUND', `Tool \"${input.toolName}\" is not registered`)
  }

  ensureToolAllowed(definition, options.policy.tool.allowDestructive)

  const toolCallId = resolveToolCallId(observedToolCalls, input.toolName, input.args)
  const invocation: ToolInvocation = {
    toolCallId,
    toolName: input.toolName,
    args: input.args,
  }
  const timestamp = Date.now()

  options.pendingOperations.set(toolCallId, {
    id: toolCallId,
    invocation,
    status: 'running',
    timestamp,
  })
  options.emitEvent({
    type: 'tool.started',
    runId: options.runId,
    toolCallId,
    invocation,
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
    const toolResult: ToolResult = {
      toolCallId,
      result,
    }

    options.pendingOperations.set(toolCallId, {
      id: toolCallId,
      invocation,
      status: 'completed',
      timestamp,
    })

    if (definition.sideEffect === 'destructive') {
      options.destructiveOperationIds.add(toolCallId)
    }

    options.emitEvent({
      type: 'tool.completed',
      runId: options.runId,
      toolCallId,
      result: toolResult,
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

    const resolvedError =
      error instanceof ToolError
        ? error
        : error instanceof TimeoutError
          ? new ToolError('TOOL_TIMEOUT', error.message, { cause: error })
          : new ToolError('TOOL_EXECUTION_FAILED', toError(error).message, {
              cause: toError(error),
            })

    options.pendingOperations.set(toolCallId, {
      id: toolCallId,
      invocation,
      status:
        definition.sideEffect === 'destructive' ? 'aborted-with-side-effect' : 'aborted-clean',
      timestamp,
    })
    options.emitEvent({
      type: 'tool.failed',
      runId: options.runId,
      toolCallId,
      invocation,
      error: resolvedError,
      timestamp: Date.now(),
    })
    throw resolvedError
  }
}

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

function convertAppMessageToDeepagentsMessage(message: AppMessage): {
  readonly role: 'user' | 'assistant' | 'system'
  readonly content: string
} {
  return {
    role: message.role,
    content: message.content.map(serializeDeepagentsMessagePart).join('\n'),
  }
}

function serializeDeepagentsMessagePart(part: AppMessage['content'][number]): string {
  if (part.type === 'text') {
    return part.text
  }

  if (part.type === 'thinking') {
    return part.thinking
  }

  if (part.type === 'image') {
    const source = part.url.startsWith('data:') ? '[embedded image omitted]' : part.url
    const mimeType = part.mimeType ?? readDataUriMimeType(part.url) ?? 'unknown'

    return `[image mimeType=${mimeType} source=${source}]`
  }

  return `[tool-call id=${part.toolCallId} name=${part.toolName} args=${stableSerialize(part.args)}]`
}

function readDataUriMimeType(url: string): string | undefined {
  if (!url.startsWith('data:')) {
    return undefined
  }

  const separatorIndex = url.indexOf(',')

  if (separatorIndex < 0) {
    return undefined
  }

  const metadata = url.slice('data:'.length, separatorIndex)
  const mimeType = metadata.split(';', 1)[0]
  return mimeType.length > 0 ? mimeType : undefined
}

function buildAssistantMessageFromDeepagentsOutput(
  messageId: string,
  createdAt: number,
  aggregatedText: string,
  output: unknown
): AppMessage {
  const outputRecord = isRecord(output) ? output : undefined
  const messages = Array.isArray(outputRecord?.messages) ? outputRecord.messages : []
  const lastMessage = messages.at(-1)
  const extractedText = readFinalOutputText(lastMessage)

  return buildAssistantMessage(messageId, createdAt, extractedText ?? aggregatedText)
}

function buildAssistantMessage(messageId: string, createdAt: number, content: string): AppMessage {
  return {
    id: messageId,
    role: 'assistant',
    content: content.length === 0 ? [] : [{ type: 'text', text: content }],
    createdAt,
  }
}

function readChunkText(chunk: unknown): string {
  if (isRecord(chunk) && typeof chunk.content === 'string') {
    return chunk.content
  }

  const kwargs = readChunkKwargs(chunk)
  return typeof kwargs?.content === 'string' ? kwargs.content : ''
}

function readToolCallChunks(chunk: unknown): Array<Record<string, unknown>> {
  if (isRecord(chunk) && Array.isArray(chunk.tool_call_chunks)) {
    return chunk.tool_call_chunks.filter(isRecord)
  }

  const kwargs = readChunkKwargs(chunk)
  const toolCallChunks = kwargs?.tool_call_chunks

  if (!Array.isArray(toolCallChunks)) {
    return []
  }

  return toolCallChunks.filter(isRecord)
}

function readToolCalls(chunk: unknown): Array<Record<string, unknown>> {
  if (isRecord(chunk) && Array.isArray(chunk.tool_calls)) {
    return chunk.tool_calls.filter(isRecord)
  }

  const kwargs = readChunkKwargs(chunk)
  const toolCalls = kwargs?.tool_calls

  if (!Array.isArray(toolCalls)) {
    return []
  }

  return toolCalls.filter(isRecord)
}

function readObservedToolCalls(chunk: unknown): DeepagentsPendingToolCall[] {
  const chunkCalls = readToolCallChunks(chunk).map((toolCallChunk) => ({
    toolCallId:
      typeof toolCallChunk.id === 'string' && toolCallChunk.id.length > 0
        ? toolCallChunk.id
        : `tool_${randomUUID()}`,
    toolName: typeof toolCallChunk.name === 'string' ? toolCallChunk.name : 'unknown_tool',
    argsText: typeof toolCallChunk.args === 'string' ? toolCallChunk.args : '',
    args: parseToolArgs(typeof toolCallChunk.args === 'string' ? toolCallChunk.args : ''),
    consumed: false,
  }))

  if (chunkCalls.length > 0) {
    return chunkCalls
  }

  return readToolCalls(chunk).map((toolCall) => {
    const args = 'args' in toolCall ? toolCall.args : undefined
    const argsText = stableSerialize(args)

    return {
      toolCallId:
        typeof toolCall.id === 'string' && toolCall.id.length > 0
          ? toolCall.id
          : `tool_${randomUUID()}`,
      toolName: typeof toolCall.name === 'string' ? toolCall.name : 'unknown_tool',
      argsText,
      args,
      consumed: false,
    }
  })
}

function readChunkKwargs(chunk: unknown): Record<string, unknown> | undefined {
  if (!isRecord(chunk)) {
    return undefined
  }

  return isRecord(chunk.kwargs) ? chunk.kwargs : undefined
}

function readFinalOutputText(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined
  }

  if (typeof message.content === 'string') {
    return message.content
  }

  const kwargs = isRecord(message.kwargs) ? message.kwargs : undefined
  return typeof kwargs?.content === 'string' ? kwargs.content : undefined
}

function parseToolArgs(value: string): unknown {
  if (value.length === 0) {
    return undefined
  }

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return 'undefined'
  }

  try {
    const seen = new WeakSet<object>()

    return JSON.stringify(value, (_key, candidate) => {
      if (typeof candidate === 'bigint') {
        return `${candidate}n`
      }

      if (!isRecord(candidate) && !Array.isArray(candidate)) {
        return candidate
      }

      if (isRecord(candidate) || Array.isArray(candidate)) {
        if (seen.has(candidate)) {
          return '[Circular]'
        }

        seen.add(candidate)
      }

      if (Array.isArray(candidate)) {
        return candidate
      }

      return sortJsonKeys('', candidate)
    })
  } catch {
    return String(value)
  }
}

function sortJsonKeys(_key: string, value: unknown): unknown {
  if (!isRecord(value) || Array.isArray(value)) {
    return value
  }

  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((record, key) => {
      record[key] = value[key]
      return record
    }, {})
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nextSequence(sequence: { current: number }): number {
  sequence.current += 1
  return sequence.current
}

async function executeWithTimeout<T>(
  operation: (abortSignal?: AbortSignal) => Promise<T>,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<T> {
  if (abortSignal?.aborted) {
    throw new CancelledError('RUN_CANCELLED', 'Run cancelled before tool execution started')
  }

  if (timeoutMs <= 0) {
    return operation(abortSignal)
  }

  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs)
  const combinedSignalScope = createAbortSignalScope(abortSignal, timeoutController.signal)
  const handleAbort = (): CancelledError =>
    new CancelledError('RUN_CANCELLED', 'Run cancelled during tool execution')
  const handleTimeout = (): TimeoutError =>
    new TimeoutError('TOOL_TIMEOUT', `Tool execution exceeded ${timeoutMs}ms`)
  const abortListener = (): void => {
    timeoutReject?.(handleAbort())
  }
  const timeoutListener = (): void => {
    timeoutReject?.(handleTimeout())
  }
  let timeoutReject: ((reason?: unknown) => void) | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutReject = reject
    abortSignal?.addEventListener('abort', abortListener, { once: true })
    timeoutController.signal.addEventListener('abort', timeoutListener, { once: true })
  })

  try {
    return await Promise.race([operation(combinedSignalScope.signal), timeoutPromise])
  } catch (error) {
    if (timeoutController.signal.aborted && !(abortSignal?.aborted ?? false)) {
      throw new TimeoutError('TOOL_TIMEOUT', `Tool execution exceeded ${timeoutMs}ms`, {
        cause: toError(error),
      })
    }

    throw error
  } finally {
    clearTimeout(timeoutId)
    abortSignal?.removeEventListener('abort', abortListener)
    timeoutController.signal.removeEventListener('abort', timeoutListener)
    combinedSignalScope.cleanup()
  }
}

function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof CancelledError || isAbortError(error) || Boolean(signal?.aborted)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}

function createAbortSignalScope(...signals: Array<AbortSignal | undefined>): AbortSignalScope {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined)

  if (activeSignals.length === 0) {
    return {
      signal: undefined,
      cleanup: () => {},
    }
  }

  if (activeSignals.length === 1) {
    return {
      signal: activeSignals[0],
      cleanup: () => {},
    }
  }

  const controller = new AbortController()

  if (activeSignals.some((signal) => signal.aborted)) {
    controller.abort()
    return {
      signal: controller.signal,
      cleanup: () => {},
    }
  }

  const listeners = activeSignals.map((signal) => {
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    return { signal, abort }
  })

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const listener of listeners) {
        listener.signal.removeEventListener('abort', listener.abort)
      }
    },
  }
}

function resolveDeepagentsCheckpointer(value: SessionRuntimeDeepagentsConfig['checkpointer']) {
  if (value === undefined || typeof value === 'boolean') {
    return value
  }

  if (isPlaceholderConfig(value)) {
    return undefined
  }

  return value
}

function resolveDeepagentsMiddleware(value: SessionRuntimeDeepagentsConfig['middleware']) {
  if (value === undefined || value.length === 0) {
    return undefined
  }

  return [...value]
}

function resolveDeepagentsSubagents(value: SessionRuntimeDeepagentsConfig['subagents']) {
  if (value === undefined || value.length === 0) {
    return undefined
  }

  return [...value]
}

function resolveDeepagentsStore(value: SessionRuntimeDeepagentsConfig['store']) {
  if (value === undefined || isPlaceholderConfig(value)) {
    return undefined
  }

  return value
}

function resolveDeepagentsBackend(value: SessionRuntimeDeepagentsConfig['backend']) {
  if (value === undefined || value === null || isPlaceholderConfig(value)) {
    return undefined
  }

  return value
}

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

function isPlaceholderConfig(value: unknown): value is { readonly kind: string } {
  return isRecord(value) && typeof value.kind === 'string'
}

function hasDeepagentsModel(value: SessionRuntimeDeepagentsConfig['model']): boolean {
  if (typeof value === 'string') {
    return value.length > 0
  }

  return value !== undefined
}

function hasConfiguredDeepagentsCheckpointer(
  value: SessionRuntimeDeepagentsConfig['checkpointer']
): boolean {
  return value !== undefined && value !== false
}
