import { randomUUID } from 'node:crypto'

import {
  type AggregatedMessageDeltaState,
  type AppMessage,
  CancelledError,
  DEFAULT_EXECUTION_POLICY,
  type ExecutionPolicy,
  type MessageDelta,
  ProviderError,
  type RunId,
  type RunSnapshot,
  type RuntimeEvent,
  type SessionId,
  type SessionSnapshot,
  TianjiError,
  TimeoutError,
  ToolError,
  type ToolInvocation,
  type ToolResult,
  type ToolSpec,
  applyMessageDelta,
  createRunId,
  createSessionId,
} from '@tianji/contracts'
import type { LlmGenerationConfig, LlmResponse } from '@tianji/llm'

import { ReplayableEventStream } from './event-stream.js'
import type { SnapshotStore } from './snapshot-store.js'
import { InMemorySnapshotStore } from './snapshot-store.js'
import {
  type RuntimeToolDefinition,
  type ToolCatalog,
  ToolRegistry,
  ensureToolAllowed,
} from './tool-catalog.js'
import { type RuntimeWorkflowState, createRuntimeWorkflow } from './workflow.js'

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
}

interface SessionRuntimeLlmToolExecutionOptions {
  readonly toolCallId: string
  readonly abortSignal?: AbortSignal
}

interface SessionRuntimeLlmRequest {
  readonly runId: RunId
  readonly messages: readonly AppMessage[]
  readonly config?: LlmGenerationConfig
  readonly systemPrompt?: string
  readonly tools?: readonly ToolSpec[]
  readonly executeTool?: (
    toolName: string,
    args: unknown,
    options: SessionRuntimeLlmToolExecutionOptions
  ) => Promise<unknown>
  readonly abortSignal?: AbortSignal
}

type SessionRuntimeLlmStreamEvent =
  | {
      readonly type: 'delta'
      readonly payload: { readonly delta: string; readonly isFinal: boolean }
    }
  | { readonly type: 'complete'; readonly payload: { readonly response: LlmResponse } }
  | {
      readonly type: 'error'
      readonly payload: { readonly message: string; readonly code?: string }
    }

interface SessionRuntimeLlmStream {
  readonly onEvent: (callback: (event: SessionRuntimeLlmStreamEvent) => void) => void
  readonly abort: () => void
  readonly waitUntilComplete: () => Promise<LlmResponse>
}

interface SessionRuntimeLlmGateway {
  readonly stream: (request: SessionRuntimeLlmRequest) => Promise<SessionRuntimeLlmStream>
}

export interface SessionRuntimeOptions {
  readonly llmGateway: SessionRuntimeLlmGateway
  readonly snapshotStore?: SnapshotStore
  readonly toolCatalog?: ToolCatalog | ToolRegistry | readonly RuntimeToolDefinition[]
  readonly defaultSystemPrompt?: string
  readonly defaultGenerationConfig?: LlmGenerationConfig
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
  readonly startedAt: number
}

interface ExecuteRunInput {
  readonly runId: RunId
  readonly sessionSnapshot: SessionSnapshot
  readonly messages: readonly AppMessage[]
  readonly policy: ExecutionPolicy
  readonly abortSignal?: AbortSignal
  readonly systemPrompt?: string
  readonly config?: LlmGenerationConfig
  readonly sourceRunId?: RunId
}

interface RunExecutionContext {
  readonly activeRun: ActiveRun
  readonly policy: ExecutionPolicy
  readonly signal: AbortSignal
  readonly toolCatalog: ToolCatalog
  readonly sequence: {
    current: number
  }
  readonly pendingOperations: Map<string, RunSnapshot['pendingOperations'][number]>
  messageState: AggregatedMessageDeltaState | undefined
}

export function createSessionRuntime(options: SessionRuntimeOptions): SessionRuntime {
  return new SessionRuntimeImpl(options)
}

class SessionRuntimeImpl implements SessionRuntime {
  private readonly snapshotStore: SnapshotStore
  private readonly toolCatalog: ToolCatalog
  private readonly workflow = createRuntimeWorkflow((state) => this.executeAssistantTurn(state))
  private readonly activeRuns = new Map<RunId, ActiveRun>()
  private readonly eventStreams = new Map<RunId, ReplayableEventStream<RuntimeEvent>>()
  private readonly runContexts = new Map<RunId, RunExecutionContext>()

  constructor(private readonly options: SessionRuntimeOptions) {
    this.snapshotStore = options.snapshotStore ?? new InMemorySnapshotStore()
    this.toolCatalog = normalizeToolCatalog(options.toolCatalog)
  }

  readonly createSession = async (options: CreateSessionOptions = {}): Promise<SessionSnapshot> => {
    const timestamp = Date.now()
    const snapshot: SessionSnapshot = {
      sessionId: options.sessionId ?? createSessionId(`session_${randomUUID()}`),
      messages: [...(options.messages ?? [])],
      createdAt: timestamp,
      updatedAt: timestamp,
      metadata: cloneMetadata(options.metadata),
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
        ...(snapshot.metadata ?? {}),
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

    const nextPolicy = options.policy ?? sessionSnapshot.policy ?? DEFAULT_EXECUTION_POLICY
    const nextSessionSnapshot: SessionSnapshot = {
      ...sessionSnapshot,
      messages: [...sessionSnapshot.messages, options.message],
      updatedAt: Date.now(),
      policy: nextPolicy,
      metadata: mergeMetadata(sessionSnapshot.metadata, options.metadata),
    }

    await this.snapshotStore.saveSession(nextSessionSnapshot)

    const runId = createRunId(`run_${randomUUID()}`)
    await this.startRun({
      runId,
      sessionSnapshot: nextSessionSnapshot,
      messages: nextSessionSnapshot.messages,
      policy: nextPolicy,
      abortSignal: options.abortSignal,
      systemPrompt: options.systemPrompt ?? this.options.defaultSystemPrompt,
      config: options.config ?? this.options.defaultGenerationConfig,
    })

    return runId
  }

  readonly resumeRun = async (options: ResumeRunOptions): Promise<RunId> => {
    const previousRun = await this.requireRunSnapshot(options.runId)
    const sessionSnapshot = await this.requireSessionSnapshot(previousRun.sessionId)
    ensureSessionOpen(sessionSnapshot)

    if (previousRun.status !== 'cancelled') {
      throw new TianjiError('state', 'RUN_NOT_CANCELLABLE', 'Only cancelled runs can be resumed')
    }

    const resumedRunId = createRunId(`run_${randomUUID()}`)
    await this.startRun({
      runId: resumedRunId,
      sessionSnapshot,
      messages: previousRun.messages,
      policy: previousRun.policy ?? sessionSnapshot.policy ?? DEFAULT_EXECUTION_POLICY,
      abortSignal: options.abortSignal,
      systemPrompt:
        options.systemPrompt ??
        readStoredSystemPrompt(previousRun.metadata) ??
        this.options.defaultSystemPrompt,
      config:
        options.config ??
        readStoredGenerationConfig(previousRun.metadata) ??
        this.options.defaultGenerationConfig,
      sourceRunId: previousRun.runId,
    })

    return resumedRunId
  }

  readonly streamEvents = (runId: RunId): AsyncIterable<RuntimeEvent> => {
    const events = this.eventStreams.get(runId)

    if (events === undefined) {
      throw new TianjiError(
        'state',
        'RUN_EVENTS_NOT_FOUND',
        `No event stream is available for run \"${runId}\"`
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
    const runSnapshot: RunSnapshot = {
      runId: input.runId,
      sessionId: input.sessionSnapshot.sessionId,
      status: 'running',
      messages: [...input.messages],
      createdAt: timestamp,
      updatedAt: timestamp,
      pendingOperations: [],
      policy: input.policy,
      metadata: {
        systemPrompt: input.systemPrompt,
        generationConfig: input.config,
        resumedFromRunId: input.sourceRunId,
      },
    }

    const events = new ReplayableEventStream<RuntimeEvent>()
    const activeRun: ActiveRun = {
      runId: input.runId,
      sessionId: input.sessionSnapshot.sessionId,
      controller: new AbortController(),
      events,
      startedAt: timestamp,
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
    const signal =
      mergeAbortSignals(input.abortSignal, activeRun.controller.signal) ??
      activeRun.controller.signal
    const context: RunExecutionContext = {
      activeRun,
      policy: input.policy,
      signal,
      toolCatalog: this.toolCatalog,
      sequence: { current: 0 },
      pendingOperations: new Map(),
      messageState: undefined,
    }

    this.runContexts.set(activeRun.runId, context)

    try {
      activeRun.events.push({
        type: 'run.started',
        runId: activeRun.runId,
        sessionId: activeRun.sessionId,
        timestamp: Date.now(),
      })

      const workflowResult = await this.workflow.invoke(
        {
          sessionId: activeRun.sessionId,
          runId: activeRun.runId,
          messages: input.messages,
          policy: input.policy,
          systemPrompt: input.systemPrompt,
          generationConfig: input.config,
        },
        {
          signal,
        }
      )

      const finalMessage = workflowResult.finalMessage

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
      const completedRunSnapshot: RunSnapshot = {
        ...runSnapshot,
        status: 'completed',
        messages: nextSessionSnapshot.messages,
        updatedAt: Date.now(),
        pendingOperations: [...context.pendingOperations.values()],
      }

      await this.snapshotStore.saveSession(nextSessionSnapshot)
      await this.snapshotStore.saveRun(completedRunSnapshot)

      activeRun.events.push({
        type: 'run.completed',
        runId: activeRun.runId,
        sessionId: activeRun.sessionId,
        timestamp: Date.now(),
      })
      activeRun.events.close()
    } catch (error) {
      if (isCancellationError(error, signal)) {
        const cancelledRunSnapshot: RunSnapshot = {
          ...runSnapshot,
          status: 'cancelled',
          updatedAt: Date.now(),
          cancelPoint: 'assistant_turn',
          pendingOperations: [...context.pendingOperations.values()],
          resumeHint: hasSideEffect(context.pendingOperations)
            ? 'require-user-confirmation'
            : 'replay',
        }

        await this.snapshotStore.saveRun(cancelledRunSnapshot)

        activeRun.events.push({
          type: 'run.cancelled',
          runId: activeRun.runId,
          sessionId: activeRun.sessionId,
          timestamp: Date.now(),
        })
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
          runId: activeRun.runId,
          sessionId: activeRun.sessionId,
          error: resolvedError,
          timestamp: Date.now(),
        })
        activeRun.events.fail(resolvedError)
      }
    } finally {
      this.runContexts.delete(activeRun.runId)
      this.activeRuns.delete(activeRun.runId)
    }
  }

  private async executeAssistantTurn(
    state: RuntimeWorkflowState
  ): Promise<Pick<RuntimeWorkflowState, 'finalMessage' | 'response'>> {
    const context = this.runContexts.get(state.runId)

    if (context === undefined) {
      throw new TianjiError(
        'state',
        'RUN_CONTEXT_NOT_FOUND',
        `Missing execution context for run \"${state.runId}\"`
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

    context.activeRun.events.push({
      type: 'message.started',
      runId: state.runId,
      messageId,
      message: initialMessage,
      timestamp: messageStartedAt,
    })

    const llmStream = await this.options.llmGateway.stream(this.buildLlmRequest(state, context))

    llmStream.onEvent((event: SessionRuntimeLlmStreamEvent) => {
      if (event.type !== 'delta' || event.payload.isFinal || event.payload.delta.length === 0) {
        return
      }

      const timestamp = Date.now()
      const delta: MessageDelta = {
        runId: state.runId,
        messageId,
        sequence: nextSequence(context.sequence),
        op: 'append',
        channel: 'text',
        payload: event.payload.delta,
        timestamp,
      }

      context.messageState = applyMessageDelta(context.messageState, delta)
      context.activeRun.events.push({
        type: 'message.delta',
        runId: state.runId,
        messageId,
        sequence: delta.sequence,
        channel: 'text',
        payload: { content: event.payload.delta },
        timestamp,
      })
    })

    const response = await llmStream.waitUntilComplete()
    const completedState = applyMessageDelta(context.messageState, {
      runId: state.runId,
      messageId,
      sequence: nextSequence(context.sequence),
      op: 'complete',
      channel: 'text',
      payload: '',
      timestamp: Date.now(),
    })

    const finalMessage = buildAssistantMessage(
      messageId,
      messageStartedAt,
      completedState?.message,
      response.content
    )

    context.activeRun.events.push({
      type: 'message.completed',
      runId: state.runId,
      messageId,
      message: finalMessage,
      timestamp: Date.now(),
    })

    return {
      finalMessage,
      response,
    }
  }

  private buildLlmRequest(state: RuntimeWorkflowState, context: RunExecutionContext) {
    const toolSpecs = context.toolCatalog.getToolSpecs()

    return {
      runId: state.runId,
      messages: state.messages,
      config: state.generationConfig,
      systemPrompt: state.systemPrompt,
      tools: toolSpecs,
      executeTool:
        toolSpecs.length === 0
          ? undefined
          : async (
              toolName: string,
              args: unknown,
              options: { toolCallId: string; abortSignal?: AbortSignal }
            ) =>
              this.executeToolCall(state, context, {
                toolCallId: options.toolCallId,
                toolName,
                args,
              }),
      abortSignal: context.signal,
    }
  }

  private async executeToolCall(
    state: RuntimeWorkflowState,
    context: RunExecutionContext,
    invocation: ToolInvocation
  ): Promise<unknown> {
    const definition = context.toolCatalog.getTool(invocation.toolName)

    if (definition === undefined) {
      throw new ToolError('TOOL_NOT_FOUND', `Tool \"${invocation.toolName}\" is not registered`)
    }

    ensureToolAllowed(definition, context.policy.tool.allowDestructive)

    const timestamp = Date.now()
    context.pendingOperations.set(invocation.toolCallId, {
      id: invocation.toolCallId,
      invocation,
      status: 'running',
      timestamp,
    })
    context.activeRun.events.push({
      type: 'tool.started',
      runId: state.runId,
      toolCallId: invocation.toolCallId,
      invocation,
      timestamp,
    })

    try {
      const result = await executeWithTimeout(
        () =>
          context.toolCatalog.executeTool(invocation, {
            sessionId: state.sessionId,
            runId: state.runId,
            toolCallId: invocation.toolCallId,
            abortSignal: context.signal,
          }),
        context.policy.tool.timeoutMs,
        context.signal
      )

      const completedResult: ToolResult = {
        toolCallId: invocation.toolCallId,
        result,
      }

      context.pendingOperations.set(invocation.toolCallId, {
        id: invocation.toolCallId,
        invocation,
        status: 'completed',
        timestamp,
      })
      context.activeRun.events.push({
        type: 'tool.completed',
        runId: state.runId,
        toolCallId: invocation.toolCallId,
        result: completedResult,
        timestamp: Date.now(),
      })

      return result
    } catch (error) {
      if (isCancellationError(error, context.signal)) {
        context.pendingOperations.set(invocation.toolCallId, {
          id: invocation.toolCallId,
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

      context.pendingOperations.set(invocation.toolCallId, {
        id: invocation.toolCallId,
        invocation,
        status:
          definition.sideEffect === 'destructive' ? 'aborted-with-side-effect' : 'aborted-clean',
        timestamp,
      })
      context.activeRun.events.push({
        type: 'tool.failed',
        runId: state.runId,
        toolCallId: invocation.toolCallId,
        invocation,
        error: resolvedError,
        timestamp: Date.now(),
      })
      throw resolvedError
    }
  }

  private async requireSessionSnapshot(sessionId: SessionId): Promise<SessionSnapshot> {
    const snapshot = await this.snapshotStore.loadSession(sessionId)

    if (snapshot === undefined) {
      throw new TianjiError('state', 'SESSION_NOT_FOUND', `Session \"${sessionId}\" does not exist`)
    }

    return snapshot
  }

  private async requireRunSnapshot(runId: RunId): Promise<RunSnapshot> {
    const snapshot = await this.snapshotStore.loadRun(runId)

    if (snapshot === undefined) {
      throw new TianjiError('state', 'RUN_NOT_FOUND', `Run \"${runId}\" does not exist`)
    }

    return snapshot
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

function buildAssistantMessage(
  messageId: string,
  createdAt: number,
  aggregatedMessage: AppMessage | undefined,
  finalContent: string
): AppMessage {
  const aggregatedText = readTextContent(aggregatedMessage)

  if (aggregatedMessage !== undefined && aggregatedText === finalContent) {
    return aggregatedMessage
  }

  return {
    id: messageId,
    role: 'assistant',
    content: finalContent.length === 0 ? [] : [{ type: 'text', text: finalContent }],
    createdAt,
  }
}

function readTextContent(message: AppMessage | undefined): string {
  if (message === undefined) {
    return ''
  }

  return message.content
    .filter(
      (part): part is Extract<AppMessage['content'][number], { type: 'text' }> =>
        part.type === 'text'
    )
    .map((part) => part.text)
    .join('')
}

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined)

  if (activeSignals.length === 0) {
    return undefined
  }

  if (activeSignals.length === 1) {
    return activeSignals[0]
  }

  const controller = new AbortController()
  const abort = (): void => controller.abort()

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort()
      return controller.signal
    }

    signal.addEventListener('abort', abort, { once: true })
  }

  return controller.signal
}

async function executeWithTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<T> {
  if (timeoutMs <= 0) {
    return operation()
  }

  const timeoutController = new AbortController()
  const signal = mergeAbortSignals(abortSignal, timeoutController.signal)
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs)

  try {
    if (signal?.aborted && !timeoutController.signal.aborted) {
      throw new CancelledError('RUN_CANCELLED', 'Run cancelled before tool execution started')
    }

    return await operation()
  } catch (error) {
    if (timeoutController.signal.aborted && !(abortSignal?.aborted ?? false)) {
      throw new TimeoutError('TOOL_TIMEOUT', `Tool execution exceeded ${timeoutMs}ms`, {
        cause: toError(error),
      })
    }

    throw error
  } finally {
    clearTimeout(timeoutId)
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

function nextSequence(sequence: { current: number }): number {
  sequence.current += 1
  return sequence.current
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof CancelledError || isAbortError(error) || Boolean(signal?.aborted)
}

function hasSideEffect(
  pendingOperations: Map<string, RunSnapshot['pendingOperations'][number]>
): boolean {
  return [...pendingOperations.values()].some(
    (operation) => operation.status === 'aborted-with-side-effect'
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
    ...(base ?? {}),
    ...(extra ?? {}),
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
      `Session \"${snapshot.sessionId}\" has been closed`
    )
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
