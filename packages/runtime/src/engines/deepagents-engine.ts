/**
 * deepagents 执行引擎主入口（薄入口文件）。
 *
 * 本文件仅包含 executeDeepagentsRun 主函数，其余实现均已按职责拆分至以下子模块：
 * - engines/deepagents/types.ts          — 内部类型定义
 * - engines/deepagents/helpers.ts        — 通用工具函数
 * - engines/deepagents/message-serialization.ts — 消息序列化
 * - engines/deepagents/stream-handlers.ts       — 流事件处理
 * - engines/deepagents/state-readers.ts         — 状态读取
 * - engines/deepagents/config-resolvers.ts      — 配置解析
 * - engines/deepagents/tool-adapter.ts          — 工具适配
 *
 * 对外触点：
 * - 由 ../runtime.ts 在每次 runTurn/resumeRun 时调用 executeDeepagentsRun。
 */
import { randomUUID } from 'node:crypto'

import { type AppMessage, TianjiError, type ToolInvocation } from '@tianji/shared'
import { createDeepAgent } from 'deepagents'

import { buildDeepagentsRunnableConfig } from '../langsmith.js'
import { LlmCallRecorder, createRecordingMiddleware } from '../llm-call-recorder.js'
import {
  buildMiddlewareList,
  hasDeepagentsModel,
  persistLlmRaw,
  resolveDeepagentsBackend,
  resolveDeepagentsCheckpointer,
  resolveDeepagentsInterruptOn,
  resolveDeepagentsStore,
  resolveDeepagentsSubagents,
} from './deepagents/config-resolvers.js'
import { buildAssistantMessage } from './deepagents/message-serialization.js'
import {
  maybeReadDeepagentsStateSnapshot,
  readDeepagentsInput,
  readDeepagentsStateMetadata,
} from './deepagents/state-readers.js'
import { dispatchStreamEvent } from './deepagents/stream-handlers.js'
import { createDeepagentsTools } from './deepagents/tool-adapter.js'
import type {
  DeepAgentFactory,
  DeepagentsPendingToolCall,
  DeepagentsRunResult,
  ExecuteDeepagentsRunOptions,
  StreamLoopState,
} from './deepagents/types.js'

export type { DeepagentsRunResult } from './deepagents/types.js'

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
  const resolvedMiddleware = buildMiddlewareList(options.deepagents.middleware, recordingMiddleware)
  const resolvedSubagents = resolveDeepagentsSubagents(options.deepagents.subagents)
  const resolvedCheckpointer = resolveDeepagentsCheckpointer(options.deepagents.checkpointer)
  const resolvedStore = resolveDeepagentsStore(options.deepagents.store)
  const resolvedBackend = resolveDeepagentsBackend(options.deepagents.backend)
  const resolvedInterruptOn = resolveDeepagentsInterruptOn(options.deepagents.interruptOn)
  const resolvedTools = createDeepagentsTools(options, observedToolCalls, turnMessages)

  void options.logger?.info(['runtime', 'deepagents'], 'deepagents.run.config', {
    sessionId: options.sessionId,
    runId: options.runId,
    threadId,
    checkpointId: options.checkpointId,
    hasResumeValue: options.resumeValue !== undefined,
    modelType: typeof options.deepagents.model,
    modelConstructor:
      typeof options.deepagents.model === 'string'
        ? undefined
        : options.deepagents.model.constructor?.name,
    backendType: resolvedBackend === undefined ? 'undefined' : typeof resolvedBackend,
    backendConstructor: resolvedBackend?.constructor?.name,
    backendKeys: readInspectableKeys(resolvedBackend),
    backendRootDir: readInspectableString(resolvedBackend, 'rootDir'),
    backendVirtualMode: readInspectableBoolean(resolvedBackend, 'virtualMode'),
    backendInheritEnv: readInspectableBoolean(resolvedBackend, 'inheritEnv'),
    hasBackendLs: hasInspectableFunction(resolvedBackend, 'ls'),
    hasBackendReadFile: hasInspectableFunction(resolvedBackend, 'readFile'),
    hasBackendWriteFile: hasInspectableFunction(resolvedBackend, 'writeFile'),
    hasBackendGlob: hasInspectableFunction(resolvedBackend, 'glob'),
    hasBackendExecute: hasInspectableFunction(resolvedBackend, 'execute'),
    checkpointerConstructor: resolvedCheckpointer?.constructor?.name,
    storeConstructor: resolvedStore?.constructor?.name,
    middlewareCount: resolvedMiddleware?.length ?? 0,
    subagentCount: resolvedSubagents?.length ?? 0,
    skillCount: options.deepagents.skills?.length ?? 0,
    interruptToolNames: resolvedInterruptOn === undefined ? [] : Object.keys(resolvedInterruptOn),
    runtimeToolNames: options.toolCatalog.getToolSpecs().map((spec) => spec.name),
    deepagentsToolNames: resolvedTools.map((tool) => tool.name),
    systemPromptLength: options.systemPrompt?.length ?? 0,
  })

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
    middleware: resolvedMiddleware,
    subagents: resolvedSubagents,
    checkpointer: resolvedCheckpointer,
    store: resolvedStore,
    backend: resolvedBackend,
    interruptOn: resolvedInterruptOn,
    skills: options.deepagents.skills ? [...options.deepagents.skills] : undefined,
    tools: resolvedTools,
  })

  const events = await agent.streamEvents(
    readDeepagentsInput(options),
    buildDeepagentsRunnableConfig({
      threadId,
      checkpointId: options.checkpointId,
      signal: options.signal,
      tracing: options.tracing,
      tracingContext: options.tracingContext,
    })
  )

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

function readInspectableKeys(value: unknown): string[] {
  if (value === undefined || value === null || typeof value !== 'object') {
    return []
  }

  return Object.keys(value).sort()
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

function hasInspectableFunction(value: unknown, key: string): boolean {
  if (value === undefined || value === null || typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>
  return typeof record[key] === 'function'
}
