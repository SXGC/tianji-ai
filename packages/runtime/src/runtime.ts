/**
 * SessionRuntime 核心实现。
 *
 * 业务职责：
 * - 维护 session/run 快照、事件流、取消恢复与工具执行状态。
 * - 统一协调 deepagents 引擎与快照存储之间的运行时协议。
 * - 保留对历史 legacy 元数据的读取兼容，但不再支持 legacy 执行。
 *
 * 对外触点：
 * - 通过 createSessionRuntime 暴露给 packages/runtime 公共入口。
 * - 调用 ./engines/deepagents-engine.ts 执行实际推理与工具调用。
 * - 依赖 @tianji/shared 提供快照、事件、错误与策略类型。
 */
import { randomUUID } from 'node:crypto'

import { ChatOpenAI } from '@langchain/openai'
import { type ObserverLogger, type ObserverStartedSpan, startToolSpan } from '@tianji/observer'
import {
  type AppMessage,
  CancelledError,
  DEFAULT_EXECUTION_POLICY,
  type ExecutionPolicy,
  type MessageCompletedEvent,
  ProviderError,
  type RunId,
  type RunSnapshot,
  type RuntimeEvent,
  type SessionId,
  type SessionSnapshot,
  TianjiError,
  type TokenUsage,
  type ToolCompletedEvent,
  type ToolFailedEvent,
  type ToolStartedEvent,
  addTokenUsage,
  createRunId,
  createSessionId,
} from '@tianji/shared'

import { type DeepagentsRunResult, executeDeepagentsRun } from './engines/deepagents-engine.js'
import { ReplayableEventStream } from './event-stream.js'
import type { LlmGenerationConfig } from './llm/index.js'
import type { SnapshotStore } from './snapshot-store.js'
import { InMemorySnapshotStore } from './snapshot-store.js'
import { type RuntimeToolDefinition, type ToolCatalog, ToolRegistry } from './tool-catalog.js'
import type { SessionRuntimeDeepagentsConfig } from './types.js'

export interface CreateSessionOptions {
  readonly sessionId?: SessionId
  readonly messages?: readonly AppMessage[]
  readonly metadata?: Record<string, unknown>
  readonly policy?: ExecutionPolicy
}

export interface RunTurnOptions {
  readonly sessionId: SessionId
  readonly message: AppMessage
  readonly abortSignal?: AbortSignal
  readonly systemPrompt?: string
  readonly config?: LlmGenerationConfig
  readonly metadata?: Record<string, unknown>
  readonly policy?: ExecutionPolicy
}

export interface ResumeRunOptions {
  readonly runId: RunId
  readonly abortSignal?: AbortSignal
  readonly systemPrompt?: string
  readonly config?: LlmGenerationConfig
  readonly resumeValue?: unknown
}

export type SessionRuntimeEngine = 'legacy' | 'deepagents'

export interface SessionRuntimeMetadata {
  readonly engine: SessionRuntimeEngine
}

export interface RunRuntimeMetadata extends SessionRuntimeMetadata {
  readonly threadId?: string
  readonly checkpointId?: string
}

export type { RuntimeProviderConfig, SessionRuntimeDeepagentsConfig } from './types.js'

export interface DeepagentsInterruptRecord {
  readonly id?: string
  readonly value?: unknown
}

export interface DeepagentsRunWorkflowState {
  readonly kind: 'deepagents-interrupt'
  readonly threadId: string
  readonly checkpointId?: string
  readonly interrupts: readonly DeepagentsInterruptRecord[]
}

export type { ObserverLogger } from '@tianji/observer'

export interface SessionRuntimeOptions {
  readonly engine?: Extract<SessionRuntimeEngine, 'deepagents'>
  readonly deepagents?: SessionRuntimeDeepagentsConfig
  readonly logger?: ObserverLogger
  readonly snapshotStore?: SnapshotStore
  readonly toolCatalog?: ToolCatalog | ToolRegistry | readonly RuntimeToolDefinition[]
}

export interface SessionRuntime {
  readonly createSession: (options?: CreateSessionOptions) => Promise<SessionSnapshot>
  readonly closeSession: (sessionId: SessionId) => Promise<SessionSnapshot>
  readonly getSessionSnapshot: (sessionId: SessionId) => Promise<SessionSnapshot | undefined>
  readonly getRunSnapshot: (runId: RunId) => Promise<RunSnapshot | undefined>
  readonly runTurn: (options: RunTurnOptions) => Promise<RunId>
  readonly resumeRun: (options: ResumeRunOptions) => Promise<RunId>
  readonly streamEvents: (runId: RunId) => AsyncIterable<RuntimeEvent>
  readonly cancelRun: (runId: RunId) => boolean
}

interface ActiveRun {
  readonly runId: RunId
  readonly sessionId: SessionId
  readonly controller: AbortController
  readonly events: ReplayableEventStream<RuntimeEvent>
}

interface ExecuteRunInput {
  readonly runId: RunId
  readonly sessionSnapshot: SessionSnapshot
  readonly messages: readonly AppMessage[]
  readonly policy: ExecutionPolicy
  readonly triggerType: RunSnapshot['triggerType']
  readonly parentRunId?: RunId
  readonly abortSignal?: AbortSignal
  readonly systemPrompt?: string
  readonly config?: LlmGenerationConfig
  readonly sourceRunId?: RunId
  readonly threadId?: string
  readonly checkpointId?: string
  readonly resumeValue?: unknown
}

interface RunExecutionContext {
  readonly signal: AbortSignal
  readonly toolCatalog: ToolCatalog
  readonly sequence: {
    current: number
  }
  readonly pendingOperations: Map<string, RunSnapshot['pendingOperations'][number]>
  readonly destructiveOperationIds: Set<string>
}

interface AbortSignalScope {
  readonly signal: AbortSignal | undefined
  readonly cleanup: () => void
}

interface RunLineageFields {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly triggerType: RunSnapshot['triggerType']
  readonly parentRunId?: RunId
}

export function createSessionRuntime(options: SessionRuntimeOptions): SessionRuntime {
  const normalizedOptions = normalizeSessionRuntimeOptions(options)
  // 统一隐藏具体实现，确保外部仅依赖稳定的 SessionRuntime 接口。
  return new SessionRuntimeImpl(normalizedOptions)
}

function normalizeSessionRuntimeOptions(options: SessionRuntimeOptions): SessionRuntimeOptions {
  if (options.deepagents === undefined) {
    return options
  }

  return {
    ...options,
    deepagents: {
      ...options.deepagents,
      model: resolveDeepagentsModel(options.deepagents),
    },
  }
}

function resolveDeepagentsModel(
  config: SessionRuntimeDeepagentsConfig
): SessionRuntimeDeepagentsConfig['model'] {
  if (typeof config.model !== 'string') {
    return config.model
  }

  if (config.providerConfig?.provider !== 'openai') {
    return config.model
  }

  if (config.providerConfig.baseUrl === undefined && config.providerConfig.headers === undefined) {
    return config.model
  }

  return new ChatOpenAI({
    model: config.providerConfig.model,
    apiKey: config.providerConfig.apiKey,
    configuration: {
      baseURL: config.providerConfig.baseUrl,
      defaultHeaders: config.providerConfig.headers,
    },
  })
}

export function readSessionRuntimeMetadata(
  metadata: Record<string, unknown> | undefined
): SessionRuntimeMetadata | undefined {
  const engine = readRuntimeEngine(metadata)

  if (engine === undefined) {
    return undefined
  }

  return { engine }
}

export function readRunRuntimeMetadata(
  metadata: Record<string, unknown> | undefined
): RunRuntimeMetadata | undefined {
  const engine = readRuntimeEngine(metadata)

  if (engine === undefined) {
    return undefined
  }

  const runtime = readRuntimeMetadataRecord(metadata)

  return {
    engine,
    threadId: typeof runtime?.threadId === 'string' ? runtime.threadId : undefined,
    checkpointId: typeof runtime?.checkpointId === 'string' ? runtime.checkpointId : undefined,
  }
}

export function readDeepagentsRunWorkflowState(
  workflowState: unknown
): DeepagentsRunWorkflowState | undefined {
  // 仅识别当前 runtime 约定的 interrupt 快照结构，避免历史脏数据污染恢复流程。
  if (!isRecord(workflowState) || workflowState.kind !== 'deepagents-interrupt') {
    return undefined
  }

  if (typeof workflowState.threadId !== 'string') {
    return undefined
  }

  const interrupts = Array.isArray(workflowState.interrupts)
    ? workflowState.interrupts.filter(isDeepagentsInterruptRecord)
    : undefined

  if (interrupts === undefined) {
    return undefined
  }

  return {
    kind: 'deepagents-interrupt',
    threadId: workflowState.threadId,
    checkpointId:
      typeof workflowState.checkpointId === 'string' ? workflowState.checkpointId : undefined,
    interrupts,
  }
}

class SessionRuntimeImpl implements SessionRuntime {
  private readonly engine: SessionRuntimeEngine
  private readonly snapshotStore: SnapshotStore
  private readonly toolCatalog: ToolCatalog
  private readonly activeRuns = new Map<RunId, ActiveRun>()
  private readonly eventStreams = new Map<RunId, ReplayableEventStream<RuntimeEvent>>()

  constructor(private readonly options: SessionRuntimeOptions) {
    const requestedEngine = readRequestedEngine(options) ?? 'deepagents'

    if (requestedEngine === 'legacy') {
      throw new TianjiError(
        'state',
        'UNSUPPORTED_RUNTIME_ENGINE',
        'The legacy runtime engine has been removed. Historical legacy snapshots remain readable, but runtime execution now requires deepagents.'
      )
    }

    this.engine = requestedEngine

    if (!hasConfiguredDeepagentsModel(options.deepagents)) {
      throw new TianjiError(
        'state',
        'INVALID_DEEPAGENTS_CONFIG',
        'deepagents.model is required when runtime execution uses deepagents'
      )
    }

    if (
      hasInterruptConfiguration(options.deepagents) &&
      !hasConfiguredDeepagentsCheckpointer(options.deepagents)
    ) {
      throw new TianjiError(
        'state',
        'INVALID_DEEPAGENTS_CONFIG',
        'deepagents.checkpointer is required when deepagents.interruptOn is configured'
      )
    }

    this.snapshotStore = options.snapshotStore ?? new InMemorySnapshotStore()
    this.toolCatalog = normalizeToolCatalog(options.toolCatalog)
  }

  readonly createSession = async (options: CreateSessionOptions = {}): Promise<SessionSnapshot> => {
    const timestamp = Date.now()
    const metadata = writeSessionRuntimeMetadata(cloneMetadata(options.metadata), {
      engine: this.engine,
    })
    const snapshot: SessionSnapshot = {
      sessionId: options.sessionId ?? createSessionId(`session_${randomUUID()}`),
      messages: [...(options.messages ?? [])],
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata,
      policy: options.policy ?? DEFAULT_EXECUTION_POLICY,
    }

    await this.snapshotStore.saveSession(snapshot)
    return snapshot
  }

  readonly closeSession = async (sessionId: SessionId): Promise<SessionSnapshot> => {
    const snapshot = await this.requireSessionSnapshot(sessionId)
    const nextSnapshot: SessionSnapshot = {
      ...snapshot,
      updatedAt: Date.now(),
      metadata: {
        ...snapshot.metadata,
        closedAt: Date.now(),
      },
    }

    for (const activeRun of this.activeRuns.values()) {
      if (activeRun.sessionId === sessionId) {
        activeRun.controller.abort()
      }
    }

    await this.snapshotStore.saveSession(nextSnapshot)
    return nextSnapshot
  }

  readonly getSessionSnapshot = (sessionId: SessionId): Promise<SessionSnapshot | undefined> =>
    this.snapshotStore.loadSession(sessionId)

  readonly getRunSnapshot = (runId: RunId): Promise<RunSnapshot | undefined> =>
    this.snapshotStore.loadRun(runId)

  readonly runTurn = async (options: RunTurnOptions): Promise<RunId> => {
    const sessionSnapshot = await this.requireSessionSnapshot(options.sessionId)
    ensureSessionOpen(sessionSnapshot)
    ensureSessionEngineMatches(sessionSnapshot, this.engine)

    const nextPolicy = options.policy ?? sessionSnapshot.policy ?? DEFAULT_EXECUTION_POLICY
    const nextSessionSnapshot: SessionSnapshot = {
      ...sessionSnapshot,
      messages: [...sessionSnapshot.messages, options.message],
      updatedAt: Date.now(),
      policy: nextPolicy,
      metadata: writeSessionRuntimeMetadata(
        mergeMetadata(sessionSnapshot.metadata, options.metadata),
        { engine: this.engine }
      ),
    }

    await this.snapshotStore.saveSession(nextSessionSnapshot)

    const runId = createRunId(`run_${randomUUID()}`)
    await this.startRun({
      runId,
      sessionSnapshot: nextSessionSnapshot,
      messages: nextSessionSnapshot.messages,
      policy: nextPolicy,
      triggerType: 'new',
      abortSignal: options.abortSignal,
      systemPrompt: options.systemPrompt,
      config: options.config,
    })

    return runId
  }

  readonly resumeRun = async (options: ResumeRunOptions): Promise<RunId> => {
    // 恢复逻辑同时兼容 checkpoint 恢复与纯重放恢复，但两者的输入约束不同。
    const previousRun = await this.requireRunSnapshot(options.runId)
    const sessionSnapshot = await this.requireSessionSnapshot(previousRun.sessionId)
    const runtimeMetadata = readRunRuntimeMetadata(previousRun.metadata)
    const workflowState = readDeepagentsRunWorkflowState(previousRun.workflowState)
    const canCheckpointResume =
      typeof runtimeMetadata?.threadId === 'string' &&
      typeof runtimeMetadata.checkpointId === 'string'
    const requiresCheckpointResume = workflowState !== undefined || canCheckpointResume

    ensureSessionOpen(sessionSnapshot)
    ensureSessionEngineMatches(sessionSnapshot, this.engine)
    ensureRunEngineMatches(previousRun, this.engine)

    if (previousRun.status !== 'cancelled') {
      throw new TianjiError('state', 'RUN_NOT_CANCELLABLE', 'Only cancelled runs can be resumed')
    }

    if (requiresCheckpointResume && !canCheckpointResume) {
      throw new TianjiError(
        'state',
        'UNSUPPORTED_DEEPAGENTS_RESUME',
        'This run captured an interrupt but is missing checkpoint metadata needed for deepagents resume'
      )
    }

    if (canCheckpointResume && options.resumeValue === undefined) {
      throw new TianjiError(
        'state',
        'MISSING_RESUME_VALUE',
        'Checkpoint-based deepagents resume requires options.resumeValue'
      )
    }

    if (!canCheckpointResume && options.resumeValue !== undefined) {
      throw new TianjiError(
        'state',
        'INVALID_RESUME_VALUE',
        'options.resumeValue can only be used when the run includes deepagents checkpoint metadata'
      )
    }

    if (!canCheckpointResume && previousRun.resumeHint === 'require-user-confirmation') {
      throw new TianjiError(
        'state',
        'UNSUPPORTED_DEEPAGENTS_RESUME',
        'This run requires user confirmation but cannot be resumed safely because no deepagents checkpoint was persisted'
      )
    }

    const resumedRunId = createRunId(`run_${randomUUID()}`)
    await this.startRun({
      runId: resumedRunId,
      sessionSnapshot,
      messages: previousRun.messages,
      policy: previousRun.policy ?? sessionSnapshot.policy ?? DEFAULT_EXECUTION_POLICY,
      triggerType: 'resume',
      parentRunId: previousRun.runId,
      abortSignal: options.abortSignal,
      systemPrompt: options.systemPrompt ?? readStoredSystemPrompt(previousRun.metadata),
      config: options.config ?? readStoredGenerationConfig(previousRun.metadata),
      sourceRunId: previousRun.runId,
      threadId: runtimeMetadata?.threadId ?? sessionSnapshot.sessionId,
      checkpointId: canCheckpointResume ? runtimeMetadata?.checkpointId : undefined,
      resumeValue: canCheckpointResume ? options.resumeValue : undefined,
    })

    return resumedRunId
  }

  readonly streamEvents = (runId: RunId): AsyncIterable<RuntimeEvent> => {
    const events = this.eventStreams.get(runId)

    if (events === undefined) {
      throw new TianjiError(
        'state',
        'RUN_EVENTS_NOT_FOUND',
        `No event stream is available for run "${runId}"`
      )
    }

    return events
  }

  readonly cancelRun = (runId: RunId): boolean => {
    const activeRun = this.activeRuns.get(runId)

    if (activeRun === undefined) {
      return false
    }

    activeRun.controller.abort()
    return true
  }

  private async startRun(input: ExecuteRunInput): Promise<void> {
    const timestamp = Date.now()
    const lineage = createRunLineageFields({
      sessionId: input.sessionSnapshot.sessionId,
      runId: input.runId,
      triggerType: input.triggerType,
      parentRunId: input.parentRunId,
    })
    const runSnapshot: RunSnapshot = {
      ...lineage,
      status: 'running',
      messages: [...input.messages],
      createdAt: timestamp,
      updatedAt: timestamp,
      pendingOperations: [],
      policy: input.policy,
      metadata: writeRunRuntimeMetadata(
        {
          systemPrompt: input.systemPrompt,
          generationConfig: input.config,
          resumedFromRunId: input.sourceRunId,
        },
        {
          engine: this.engine,
          threadId: input.threadId ?? input.sessionSnapshot.sessionId,
          checkpointId: input.checkpointId,
        }
      ),
    }

    const events = new ReplayableEventStream<RuntimeEvent>()
    const activeRun: ActiveRun = {
      runId: input.runId,
      sessionId: input.sessionSnapshot.sessionId,
      controller: new AbortController(),
      events,
    }

    this.activeRuns.set(input.runId, activeRun)
    this.eventStreams.set(input.runId, events)
    await this.snapshotStore.saveRun(runSnapshot)

    void this.executeRun(activeRun, runSnapshot, input)
  }

  private async executeRun(
    activeRun: ActiveRun,
    runSnapshot: RunSnapshot,
    input: ExecuteRunInput
  ): Promise<void> {
    const abortSignalScope = createAbortSignalScope(input.abortSignal, activeRun.controller.signal)
    const lineage = createRunLineageFields(runSnapshot)
    const context: RunExecutionContext = {
      signal: abortSignalScope.signal ?? activeRun.controller.signal,
      toolCatalog: this.toolCatalog,
      sequence: { current: 0 },
      pendingOperations: new Map(),
      destructiveOperationIds: new Set(),
    }

    try {
      activeRun.events.push({
        type: 'run.started',
        ...lineage,
        timestamp: Date.now(),
      })
      this.logRunLifecycle('info', 'run.started', lineage)

      const result = await this.executeDeepagentsTurn(activeRun, input, context)
      const completedRunMetadata = writeRunRuntimeMetadata(runSnapshot.metadata, {
        engine: this.engine,
        threadId: result.threadId,
        checkpointId: result.checkpointId,
      })

      // 将 run 级别的 token 用量写入 metadata，供查询和日志使用。
      const runMetadataWithUsage =
        result.usage !== undefined
          ? { ...completedRunMetadata, usage: result.usage }
          : completedRunMetadata

      if (result.interrupts !== undefined && result.interrupts.length > 0) {
        // deepagents 进入 HITL 中断时将其映射为 cancelled run，并持久化恢复所需 checkpoint/interrupt 信息。
        const interruptedRunSnapshot: RunSnapshot = {
          ...runSnapshot,
          status: 'cancelled',
          updatedAt: Date.now(),
          cancelPoint: 'human-in-the-loop',
          pendingOperations: [...context.pendingOperations.values()],
          resumeHint: 'require-user-confirmation',
          workflowState: writeDeepagentsRunWorkflowState({
            threadId: result.threadId,
            checkpointId: result.checkpointId,
            interrupts: result.interrupts,
          }),
          metadata: runMetadataWithUsage,
        }

        await this.snapshotStore.saveRun(interruptedRunSnapshot)

        activeRun.events.push({
          type: 'run.cancelled',
          ...lineage,
          timestamp: Date.now(),
        })
        this.logRunLifecycle('info', 'run.cancelled', lineage)
        activeRun.events.close()
        return
      }

      if (result.turnMessages.length === 0) {
        throw new ProviderError(
          'RUN_EMPTY_RESPONSE',
          'Runtime workflow finished without any messages'
        )
      }

      // 将本次 run 的 token 用量累加到 session 级别。
      const sessionMetadataWithUsage =
        result.usage !== undefined
          ? {
              ...input.sessionSnapshot.metadata,
              usage: addTokenUsage(readTokenUsage(input.sessionSnapshot.metadata), result.usage),
            }
          : input.sessionSnapshot.metadata

      const nextSessionSnapshot: SessionSnapshot = {
        ...input.sessionSnapshot,
        messages: [...input.sessionSnapshot.messages, ...result.turnMessages],
        updatedAt: Date.now(),
        metadata: sessionMetadataWithUsage,
      }
      const completedRunSnapshot: RunSnapshot = {
        ...runSnapshot,
        status: 'completed',
        messages: nextSessionSnapshot.messages,
        updatedAt: Date.now(),
        pendingOperations: [...context.pendingOperations.values()],
        metadata: runMetadataWithUsage,
      }

      await this.snapshotStore.saveSession(nextSessionSnapshot)
      await this.snapshotStore.saveRun(completedRunSnapshot)

      activeRun.events.push({
        type: 'run.completed',
        ...lineage,
        timestamp: Date.now(),
      })
      this.logRunLifecycle('info', 'run.completed', lineage)
      activeRun.events.close()
    } catch (error) {
      if (isCancellationError(error, context.signal)) {
        const cancelledRunSnapshot: RunSnapshot = {
          ...runSnapshot,
          status: 'cancelled',
          updatedAt: Date.now(),
          cancelPoint: 'assistant_turn',
          pendingOperations: [...context.pendingOperations.values()],
          resumeHint: hasSideEffect(context.pendingOperations, context.destructiveOperationIds)
            ? 'require-user-confirmation'
            : 'replay',
        }

        await this.snapshotStore.saveRun(cancelledRunSnapshot)

        activeRun.events.push({
          type: 'run.cancelled',
          ...lineage,
          timestamp: Date.now(),
        })
        this.logRunLifecycle('warn', 'run.cancelled', lineage)
        activeRun.events.close()
      } else {
        const resolvedError = toTianjiError(error)
        const failedRunSnapshot: RunSnapshot = {
          ...runSnapshot,
          status: 'failed',
          updatedAt: Date.now(),
          pendingOperations: [...context.pendingOperations.values()],
          metadata: mergeMetadata(runSnapshot.metadata, {
            failureCode: resolvedError.code,
          }),
        }

        await this.snapshotStore.saveRun(failedRunSnapshot)

        activeRun.events.push({
          type: 'run.failed',
          ...lineage,
          error: resolvedError,
          timestamp: Date.now(),
        })
        this.logRunLifecycle('error', 'run.failed', lineage, {
          errorCode: resolvedError.code,
        })
        activeRun.events.fail(resolvedError)
      }
    } finally {
      abortSignalScope.cleanup()
      this.activeRuns.delete(activeRun.runId)
    }
  }

  private async executeDeepagentsTurn(
    activeRun: ActiveRun,
    input: ExecuteRunInput,
    context: RunExecutionContext
  ): Promise<DeepagentsRunResult> {
    const deepagents = this.options.deepagents

    if (deepagents === undefined) {
      throw new TianjiError(
        'state',
        'MISSING_DEEPAGENTS_CONFIG',
        'deepagents configuration is required when engine is set to deepagents'
      )
    }

    const lineage = createRunLineageFields({
      sessionId: activeRun.sessionId,
      runId: activeRun.runId,
      triggerType: input.triggerType,
      parentRunId: input.parentRunId,
    })

    /** per-run 工具 span 跟踪，run 结束后闭包释放自动 GC */
    const toolSpans = new Map<string, ObserverStartedSpan>()

    return executeDeepagentsRun({
      sessionId: activeRun.sessionId,
      runId: activeRun.runId,
      messages: input.messages,
      signal: context.signal,
      policy: input.policy,
      config: input.config,
      systemPrompt: input.systemPrompt,
      deepagents,
      threadId: input.threadId,
      checkpointId: input.checkpointId,
      resumeValue: input.resumeValue,
      toolCatalog: context.toolCatalog,
      pendingOperations: context.pendingOperations,
      destructiveOperationIds: context.destructiveOperationIds,
      sequence: context.sequence,
      emitEvent: (event) => {
        activeRun.events.push(event)
        if (
          event.type === 'tool.started' ||
          event.type === 'tool.completed' ||
          event.type === 'tool.failed'
        ) {
          this.logToolEvent(event, lineage)
        }
        if (event.type === 'message.completed') {
          this.logMessageEvent(event, lineage)
        }
        if (event.type === 'tool.started') {
          const span = startToolSpan({
            toolName: event.invocation.toolName,
            runId: event.runId,
          })
          if (span !== undefined) {
            toolSpans.set(event.toolCallId, span)
          }
        }
        if (event.type === 'tool.completed' || event.type === 'tool.failed') {
          const span = toolSpans.get(event.toolCallId)
          if (span !== undefined) {
            span.end()
            toolSpans.delete(event.toolCallId)
          }
        }
      },
    })
  }

  private async requireSessionSnapshot(sessionId: SessionId): Promise<SessionSnapshot> {
    const snapshot = await this.snapshotStore.loadSession(sessionId)

    if (snapshot === undefined) {
      throw new TianjiError('state', 'SESSION_NOT_FOUND', `Session "${sessionId}" does not exist`)
    }

    return snapshot
  }

  private async requireRunSnapshot(runId: RunId): Promise<RunSnapshot> {
    const snapshot = await this.snapshotStore.loadRun(runId)

    if (snapshot === undefined) {
      throw new TianjiError('state', 'RUN_NOT_FOUND', `Run "${runId}" does not exist`)
    }

    return snapshot
  }

  /**
   * 统一输出 run 生命周期 observer 日志，确保链路标识只在一个位置组装。
   */
  private logRunLifecycle(
    level: 'info' | 'warn' | 'error',
    message: 'run.started' | 'run.completed' | 'run.failed' | 'run.cancelled',
    fields: RunLineageFields,
    extraData?: Record<string, unknown>
  ): void {
    const logger = this.options.logger

    if (logger === undefined) {
      return
    }

    const data: Record<string, unknown> = {
      sessionId: fields.sessionId,
      runId: fields.runId,
      triggerType: fields.triggerType,
      ...(fields.parentRunId === undefined ? undefined : { parentRunId: fields.parentRunId }),
      ...extraData,
    }

    void logger[level](['runtime', 'run'], message, data)
  }

  /**
   * 将工具事件写入 observer logger，scope 为 ['runtime', 'tool']。
   * runtime 层记录所有 session 的工具事件，与 TaskExecutor 层的单任务摘要日志互补。
   */
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

  /**
   * 将 message.completed 事件写入 observer logger，scope 为 ['runtime', 'message']。
   * 记录消息摘要，包含 thinking/tool-call 标记与文本预览。
   */
  private logMessageEvent(event: MessageCompletedEvent, fields: RunLineageFields): void {
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
}

function createRunLineageFields(fields: RunLineageFields): RunLineageFields {
  return {
    sessionId: fields.sessionId,
    runId: fields.runId,
    triggerType: fields.triggerType,
    parentRunId: fields.parentRunId,
  }
}

function normalizeToolCatalog(toolCatalog: SessionRuntimeOptions['toolCatalog']): ToolCatalog {
  if (toolCatalog === undefined) {
    return new ToolRegistry()
  }

  if (toolCatalog instanceof ToolRegistry) {
    return toolCatalog.createCatalog()
  }

  if (Array.isArray(toolCatalog)) {
    return new ToolRegistry(toolCatalog).createCatalog()
  }

  if (isToolCatalog(toolCatalog)) {
    return toolCatalog
  }

  return new ToolRegistry()
}

function isToolCatalog(value: SessionRuntimeOptions['toolCatalog']): value is ToolCatalog {
  return value !== undefined && !Array.isArray(value) && !(value instanceof ToolRegistry)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}

function toTianjiError(error: unknown): TianjiError {
  if (error instanceof TianjiError) {
    return error
  }

  return new ProviderError('RUNTIME_EXECUTION_FAILED', toError(error).message, {
    cause: toError(error),
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof CancelledError || isAbortError(error) || Boolean(signal?.aborted)
}

function hasSideEffect(
  pendingOperations: Map<string, RunSnapshot['pendingOperations'][number]>,
  destructiveOperationIds: ReadonlySet<string>
): boolean {
  return [...pendingOperations.values()].some(
    (operation) =>
      operation.status === 'aborted-with-side-effect' ||
      (operation.status === 'completed' && destructiveOperationIds.has(operation.id))
  )
}

function mergeMetadata(
  base: Record<string, unknown> | undefined,
  extra: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (base === undefined && extra === undefined) {
    return undefined
  }

  return {
    ...base,
    ...extra,
  }
}

function cloneMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return metadata === undefined ? undefined : { ...metadata }
}

function ensureSessionOpen(snapshot: SessionSnapshot): void {
  if (snapshot.metadata?.closedAt !== undefined) {
    throw new TianjiError(
      'state',
      'SESSION_CLOSED',
      `Session "${snapshot.sessionId}" has been closed`
    )
  }
}

function ensureSessionEngineMatches(
  snapshot: SessionSnapshot,
  expectedEngine: SessionRuntimeEngine
): void {
  const storedEngine = readSessionRuntimeMetadata(snapshot.metadata)?.engine ?? 'legacy'

  if (storedEngine !== expectedEngine) {
    throw new TianjiError(
      'state',
      'SESSION_ENGINE_MISMATCH',
      `Session "${snapshot.sessionId}" is bound to runtime engine "${storedEngine}", but the current runtime is using "${expectedEngine}"`
    )
  }
}

function ensureRunEngineMatches(snapshot: RunSnapshot, expectedEngine: SessionRuntimeEngine): void {
  const storedEngine = readRunRuntimeMetadata(snapshot.metadata)?.engine ?? 'legacy'

  if (storedEngine === expectedEngine) {
    return
  }

  throw new TianjiError(
    'state',
    'SESSION_ENGINE_MISMATCH',
    `Run "${snapshot.runId}" is bound to runtime engine "${storedEngine}", but the current runtime is using "${expectedEngine}"`
  )
}

function readRuntimeMetadataRecord(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const runtime = metadata?.runtime

  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) {
    return undefined
  }

  return runtime as Record<string, unknown>
}

function readRuntimeEngine(
  metadata: Record<string, unknown> | undefined
): SessionRuntimeEngine | undefined {
  const engine = readRuntimeMetadataRecord(metadata)?.engine

  return engine === 'legacy' || engine === 'deepagents' ? engine : undefined
}

function readRequestedEngine(options: SessionRuntimeOptions): SessionRuntimeEngine | undefined {
  const engine = (options as Record<string, unknown>).engine

  return engine === 'legacy' || engine === 'deepagents' ? engine : undefined
}

function writeSessionRuntimeMetadata(
  metadata: Record<string, unknown> | undefined,
  runtimeMetadata: SessionRuntimeMetadata
): Record<string, unknown> {
  return {
    ...metadata,
    runtime: {
      ...readRuntimeMetadataRecord(metadata),
      engine: runtimeMetadata.engine,
    },
  }
}

function writeRunRuntimeMetadata(
  metadata: Record<string, unknown> | undefined,
  runtimeMetadata: RunRuntimeMetadata
): Record<string, unknown> {
  const nextRuntimeMetadata: Record<string, unknown> = {
    ...readRuntimeMetadataRecord(metadata),
    engine: runtimeMetadata.engine,
  }

  if (runtimeMetadata.threadId !== undefined) {
    nextRuntimeMetadata.threadId = runtimeMetadata.threadId
  }

  if (runtimeMetadata.checkpointId !== undefined) {
    nextRuntimeMetadata.checkpointId = runtimeMetadata.checkpointId
  }

  return {
    ...metadata,
    runtime: nextRuntimeMetadata,
  }
}

function writeDeepagentsRunWorkflowState(
  state: Omit<DeepagentsRunWorkflowState, 'kind'>
): DeepagentsRunWorkflowState {
  return {
    kind: 'deepagents-interrupt',
    threadId: state.threadId,
    checkpointId: state.checkpointId,
    interrupts: state.interrupts.map((interrupt) => ({
      id: interrupt.id,
      value: interrupt.value,
    })),
  }
}

function readStoredSystemPrompt(metadata: Record<string, unknown> | undefined): string | undefined {
  const systemPrompt = metadata?.systemPrompt
  return typeof systemPrompt === 'string' ? systemPrompt : undefined
}

function readStoredGenerationConfig(
  metadata: Record<string, unknown> | undefined
): LlmGenerationConfig | undefined {
  const config = metadata?.generationConfig
  return typeof config === 'object' && config !== null ? (config as LlmGenerationConfig) : undefined
}

function hasConfiguredDeepagentsModel(
  deepagents: SessionRuntimeOptions['deepagents']
): deepagents is SessionRuntimeDeepagentsConfig {
  if (deepagents === undefined) {
    return false
  }

  if (typeof deepagents.model === 'string') {
    return deepagents.model.length > 0
  }

  return deepagents.model !== undefined
}

function hasInterruptConfiguration(
  deepagents: SessionRuntimeDeepagentsConfig | undefined
): boolean {
  return deepagents?.interruptOn !== undefined && Object.keys(deepagents.interruptOn).length > 0
}

function hasConfiguredDeepagentsCheckpointer(
  deepagents: SessionRuntimeDeepagentsConfig | undefined
): boolean {
  return deepagents?.checkpointer !== undefined && deepagents.checkpointer !== false
}

/**
 * 从 metadata 中安全读取 TokenUsage，类型不匹配时返回 undefined。
 */
function readTokenUsage(metadata: Record<string, unknown> | undefined): TokenUsage | undefined {
  const usage = metadata?.usage

  if (typeof usage !== 'object' || usage === null) {
    return undefined
  }

  const candidate = usage as {
    inputTokens?: unknown
    outputTokens?: unknown
    totalTokens?: unknown
  }

  if (
    typeof candidate.inputTokens !== 'number' ||
    typeof candidate.outputTokens !== 'number' ||
    typeof candidate.totalTokens !== 'number'
  ) {
    return undefined
  }

  return {
    inputTokens: candidate.inputTokens,
    outputTokens: candidate.outputTokens,
    totalTokens: candidate.totalTokens,
  }
}
