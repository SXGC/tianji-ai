/**
 * SessionRuntimeImpl 核心实现与工厂函数。
 *
 * 业务职责：
 * - 维护 session/run 快照、事件流、取消恢复与工具执行状态。
 * - 统一协调 deepagents 引擎与快照存储之间的运行时协议。
 * - 保留对历史 legacy 元数据的读取兼容，但不再支持 legacy 执行。
 *
 * 对外触点：
 * - 通过 createSessionRuntime 暴露给 runtime.ts barrel，再由 index.ts 对外。
 * - 调用 engines/deepagents-engine.ts 执行实际推理与工具调用。
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { ChatOpenAI } from '@langchain/openai'
import { type ObserverStartedSpan, startToolSpan } from '@tianji/observer'
import {
  DEFAULT_EXECUTION_POLICY,
  type DomainEvent,
  type RunId,
  type RunSnapshot,
  type SessionId,
  type SessionSnapshot,
  TianjiError,
  type TokenUsage,
  createRunId,
  createSessionId,
} from '@tianji/shared'

import { resolveConfigPaths } from '../config.js'
import { type DeepagentsRunResult, executeDeepagentsRun } from '../engines/deepagents-engine.js'
import { ReplayableEventStream } from '../event-stream.js'
import {
  type RuntimeTracingContext,
  type RuntimeTracingState,
  createRuntimeTracingState,
  mergeTracingContexts,
} from '../langsmith.js'
import { InMemorySnapshotStore } from '../snapshot-store.js'
import type { SnapshotStore } from '../snapshot-store.js'
import { ToolRegistry } from '../tool-catalog.js'
import type { ToolCatalog } from '../tool-catalog.js'
import type { SessionRuntimeDeepagentsConfig } from '../types.js'
import {
  createAbortSignalScope,
  createRunLineageFields,
  isCancellationError,
  normalizeToolCatalog,
} from './helpers.js'
import {
  cloneMetadata,
  ensureRunEngineMatches,
  ensureSessionEngineMatches,
  ensureSessionOpen,
  hasConfiguredDeepagentsCheckpointer,
  hasConfiguredDeepagentsModel,
  hasInterruptConfiguration,
  mergeMetadata,
  readDeepagentsRunWorkflowState,
  readRequestedEngine,
  readRunRuntimeMetadata,
  readStoredGenerationConfig,
  readStoredSystemPrompt,
  writeRunRuntimeMetadata,
  writeSessionRuntimeMetadata,
} from './metadata.js'
import {
  type RunLifecycleDeps,
  handleRunCancellation,
  handleRunFailure,
  handleRunSuccess,
  logMessageEvent,
  logRunLifecycle,
  logToolEvent,
} from './run-lifecycle.js'
import type {
  ActiveRun,
  CreateSessionOptions,
  ExecuteRunInput,
  ResumeRunOptions,
  RunExecutionContext,
  RunLineageFields,
  RunTurnOptions,
  SessionRuntime,
  SessionRuntimeEngine,
  SessionRuntimeOptions,
} from './types.js'

/**
 * 创建 SessionRuntime 实例。
 * 统一隐藏具体实现，确保外部仅依赖稳定的 SessionRuntime 接口。
 */
export function createSessionRuntime(options: SessionRuntimeOptions): SessionRuntime {
  const normalizedOptions = normalizeSessionRuntimeOptions(options)
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

class SessionRuntimeImpl implements SessionRuntime {
  private readonly engine: SessionRuntimeEngine
  private readonly snapshotStore: SnapshotStore
  private readonly toolCatalog: ToolCatalog
  private readonly tracing: RuntimeTracingState
  private readonly activeRuns = new Map<RunId, ActiveRun>()
  private readonly eventStreams = new Map<RunId, ReplayableEventStream<DomainEvent>>()

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
    this.tracing = createRuntimeTracingState(options.tracing)
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

  readonly openSession = async (sessionId: SessionId): Promise<SessionSnapshot> => {
    const snapshot = await this.requireSessionSnapshot(sessionId)
    ensureSessionEngineMatches(snapshot, this.engine)
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

  readonly streamEvents = (runId: RunId): AsyncIterable<DomainEvent> => {
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

    const events = new ReplayableEventStream<DomainEvent>()
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
    const deps: RunLifecycleDeps = {
      snapshotStore: this.snapshotStore,
      logger: this.options.logger,
      engine: this.engine,
    }

    // 在 try 外声明，使 catch 中的取消路径也能访问已消耗的 token 用量。
    let capturedUsage: TokenUsage | undefined

    try {
      activeRun.events.push({
        type: 'RunStarted',
        ...lineage,
        timestamp: Date.now(),
      })
      logRunLifecycle(deps.logger, 'info', 'run.started', lineage)

      const result = await this.executeDeepagentsTurn(activeRun, input, context)
      capturedUsage = result.usage

      await handleRunSuccess(deps, activeRun, runSnapshot, input, context, lineage, result)
    } catch (error) {
      if (isCancellationError(error, context.signal)) {
        await handleRunCancellation(deps, activeRun, runSnapshot, context, lineage, capturedUsage)
      } else {
        await handleRunFailure(deps, activeRun, runSnapshot, context, lineage, error, capturedUsage)
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
      llmRawDir:
        deepagents.llmRawDir ?? join(resolveConfigPaths().userConfigDir, 'runtime-snapshots'),
      tracing: this.tracing,
      tracingContext: this.buildTracingContext(activeRun, input, deepagents),
      logger: this.options.logger,
      emitEvent: (event) => {
        activeRun.events.push(event)
        if (
          event.type === 'ToolStarted' ||
          event.type === 'ToolCompleted' ||
          event.type === 'ToolFailed'
        ) {
          logToolEvent(this.options.logger, event, lineage)
        }
        if (event.type === 'MessageCompleted') {
          logMessageEvent(this.options.logger, event, lineage)
        }
        if (event.type === 'ToolStarted') {
          const span = startToolSpan({
            toolName: event.invocation.toolName,
            runId: event.runId,
          })
          if (span !== undefined) {
            toolSpans.set(event.toolCallId, span)
          }
        }
        if (event.type === 'ToolCompleted' || event.type === 'ToolFailed') {
          const span = toolSpans.get(event.toolCallId)
          if (span !== undefined) {
            span.end()
            toolSpans.delete(event.toolCallId)
          }
        }
      },
    })
  }

  private buildTracingContext(
    activeRun: ActiveRun,
    input: ExecuteRunInput,
    deepagents: SessionRuntimeDeepagentsConfig
  ): RuntimeTracingContext {
    const runtimeContext: RuntimeTracingContext = {
      tags: ['tianji', 'runtime', `trigger:${input.triggerType}`],
      metadata: {
        sessionId: activeRun.sessionId,
        runId: activeRun.runId,
        triggerType: input.triggerType,
        model:
          typeof deepagents.model === 'string'
            ? deepagents.model
            : (deepagents.model.constructor?.name ?? 'unknown'),
        ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
        ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        ...(input.checkpointId !== undefined ? { checkpointId: input.checkpointId } : {}),
      },
    }

    return (
      mergeTracingContexts(this.options.externalTracingContext, runtimeContext) ?? runtimeContext
    )
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
}
