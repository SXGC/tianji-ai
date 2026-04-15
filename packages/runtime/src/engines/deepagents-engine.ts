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
  buildMiddlewareList,
  hasConfiguredDeepagentsCheckpointer,
  hasDeepagentsModel,
  persistLlmRaw,
  resolveDeepagentsBackend,
  resolveDeepagentsCheckpointer,
  resolveDeepagentsInterruptOn,
  resolveDeepagentsStore,
  resolveDeepagentsSubagents,
} from './deepagents/config-resolvers.js'
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
  readObservedToolCalls,
  registerObservedToolCalls,
} from './deepagents/message-serialization.js'
import {
  maybeReadDeepagentsStateSnapshot,
  readDeepagentsInput,
  readDeepagentsStateMetadata,
} from './deepagents/state-readers.js'
import { dispatchStreamEvent } from './deepagents/stream-handlers.js'

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
