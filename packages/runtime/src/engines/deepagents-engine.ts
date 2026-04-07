/**
 * deepagents 执行引擎适配层。
 *
 * 业务职责：
 * - 将 SessionRuntime 的消息、工具、取消与事件协议转换为 deepagents 所需格式。
 * - 统一处理流式文本、工具调用观测、checkpoint 状态回读与超时控制。
 * - 保持 @tianji/shared 定义的 RuntimeEvent / ToolResult / 错误语义稳定。
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
} from '@tianji/shared'
import { createDeepAgent } from 'deepagents'

import type { LlmGenerationConfig } from '../llm/index.js'
import type { ToolCatalog } from '../tool-catalog.js'
import { ensureToolAllowed } from '../tool-catalog.js'
import type { SessionRuntimeDeepagentsConfig } from '../types.js'

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

function isLangGraphChainEnd(event: { event: string; name?: string }): boolean {
  return event.event === 'on_chain_end' && event.name === 'LangGraph'
}

/**
 * 执行一次 deepagents 运行并将其完整映射为 RuntimeEvent / RunResult。
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

    if (isLangGraphChainEnd(event)) {
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

/**
 * 将一次运行请求转换为 deepagents 可接受的输入。
 * 恢复执行时优先构造 Command.resume；普通执行则把历史消息序列转换为 deepagents messages。
 */
function readDeepagentsInput(options: ExecuteDeepagentsRunOptions): unknown {
  if (options.resumeValue !== undefined) {
    return new Command({ resume: options.resumeValue })
  }

  return {
    messages: options.messages.map(convertAppMessageToDeepagentsMessage),
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

    const resolvedError = resolveToolError(error)

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
 * 将 AppMessage 压平为 deepagents 只接受的 role + string content 结构。
 */
function convertAppMessageToDeepagentsMessage(message: AppMessage): {
  readonly role: 'user' | 'assistant' | 'system'
  readonly content: string
} {
  return {
    role: message.role,
    content: message.content.map(serializeDeepagentsMessagePart).join('\n'),
  }
}

/**
 * 序列化单个消息片段，尽量保留文本语义，并为图片/工具调用生成可读占位文本。
 */
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

/**
 * 从 data URI 中提取 mime type；不是 data URI 或格式非法时返回 undefined。
 */
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

/**
 * 从 deepagents 最终输出中提取最后一条 assistant 文本；若提取失败则回退到流式聚合文本。
 */
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

/**
 * 构造标准 assistant 消息对象，并在空文本时保持 content 为空数组。
 */
function buildAssistantMessage(messageId: string, createdAt: number, content: string): AppMessage {
  return {
    id: messageId,
    role: 'assistant',
    content: content.length === 0 ? [] : [{ type: 'text', text: content }],
    createdAt,
  }
}

/**
 * 读取单个模型流式 chunk 中的文本增量。
 */
function readChunkText(chunk: unknown): string {
  if (isRecord(chunk) && typeof chunk.content === 'string') {
    return chunk.content
  }

  const kwargs = readChunkKwargs(chunk)
  return typeof kwargs?.content === 'string' ? kwargs.content : ''
}

/**
 * 读取 chunk 中按片段返回的 tool_call_chunks。
 */
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

/**
 * 读取 chunk 中已聚合完成的 tool_calls。
 */
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

/**
 * 从 chunk 中提取 runtime 可跟踪的工具调用观测记录，兼容增量片段和完整调用两种格式。
 */
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

/**
 * 读取 chunk.kwargs，并确保其为对象结构。
 */
function readChunkKwargs(chunk: unknown): Record<string, unknown> | undefined {
  if (!isRecord(chunk)) {
    return undefined
  }

  return isRecord(chunk.kwargs) ? chunk.kwargs : undefined
}

/**
 * 提取 deepagents 最终消息中的文本内容。
 */
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

/**
 * 解析工具参数字符串；无法解析为 JSON 时保留原始字符串。
 */
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

/**
 * 以稳定顺序序列化任意值，供工具参数比较和日志占位使用。
 * 该实现额外处理 bigint、循环引用与对象键排序，避免相同语义对象因键顺序不同而无法匹配。
 */
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
    if (typeof value === 'string') {
      return value
    }

    try {
      return JSON.stringify(value) ?? 'undefined'
    } catch {
      return '[Unserializable]'
    }
  }
}

/**
 * 递归前对对象键排序，保证 JSON 序列化结果稳定。
 */
function sortJsonKeys(_key: string, value: unknown): unknown {
  if (!isRecord(value) || Array.isArray(value)) {
    return value
  }

  return Object.keys(value)
    .sort((a, b) => a.localeCompare(b))
    .reduce<Record<string, unknown>>((record, key) => {
      record[key] = value[key]
      return record
    }, {})
}

/**
 * 判断值是否为非 null 对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 递增并返回事件序号。
 */
function nextSequence(sequence: { current: number }): number {
  sequence.current += 1
  return sequence.current
}

/**
 * 在统一取消信号之上为异步操作叠加超时控制。
 *
 * 该函数会把外部取消与内部 timeout 合并为单个 abortSignal，使用 Promise.race 抢占结果，
 * 并在 finally 中清理所有监听器，避免长生命周期会话中出现事件监听泄漏。
 */
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

/**
 * 判断错误是否可视为取消中断。
 */
function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof CancelledError || isAbortError(error) || Boolean(signal?.aborted)
}

/**
 * 判断错误是否为标准 AbortError。
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * 将未知错误规范化为 Error 实例。
 */
function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}

/**
 * 将工具执行过程中捕获的未知错误归一化为 ToolError。
 * - 已经是 ToolError 直接返回。
 * - TimeoutError 映射为 TOOL_TIMEOUT。
 * - 其余情况包装为 TOOL_EXECUTION_FAILED。
 */
function resolveToolError(error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error
  }
  if (error instanceof TimeoutError) {
    return new ToolError('TOOL_TIMEOUT', error.message, { cause: error })
  }
  const wrapped = toError(error)
  return new ToolError('TOOL_EXECUTION_FAILED', wrapped.message, { cause: wrapped })
}

/**
 * 合并多个 AbortSignal，并返回可清理的监听作用域。
 * 只要任一信号中断，合成信号就会立刻中断；cleanup 用于移除注册的事件监听器。
 */
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
