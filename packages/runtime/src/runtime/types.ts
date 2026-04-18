/**
 * runtime 模块公共与内部类型定义。
 *
 * 业务职责：
 * - 集中存放 session/run 生命周期所需的所有类型声明，避免类型分散在实现文件中。
 *
 * 对外触点：
 * - 被 runtime.ts barrel 转发外部可见类型。
 * - 被 runtime/ 子模块内部使用内部类型（ActiveRun / ExecuteRunInput 等）。
 */
import type {
  AppMessage,
  DomainEvent,
  ExecutionPolicy,
  OrchestrationGraph,
  RunId,
  RunSnapshot,
  SessionId,
  SessionSnapshot,
  TokenUsage,
} from '@tianji/shared'

import type { ObserverLogger } from '@tianji/observer'
import type { ReplayableEventStream } from '../event-stream.js'
import type { RuntimeTracingContext } from '../langsmith.js'
import type { LlmGenerationConfig } from '../llm/index.js'
import type { SnapshotStore } from '../snapshot-store.js'
import type { RuntimeToolDefinition, ToolCatalog, ToolRegistry } from '../tool-catalog.js'
import type { SessionRuntimeDeepagentsConfig, SessionRuntimeTracingConfig } from '../types.js'

// ── 公共类型（re-export 到 index.ts）──────────────────────────────────────────

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

export interface SessionRuntimeOptions {
  readonly engine?: Extract<SessionRuntimeEngine, 'deepagents'>
  readonly deepagents?: SessionRuntimeDeepagentsConfig
  readonly tracing?: SessionRuntimeTracingConfig
  readonly externalTracingContext?: RuntimeTracingContext
  readonly logger?: ObserverLogger
  readonly snapshotStore?: SnapshotStore
  readonly toolCatalog?: ToolCatalog | ToolRegistry | readonly RuntimeToolDefinition[]
}

export interface SessionRuntime {
  readonly createSession: (options?: CreateSessionOptions) => Promise<SessionSnapshot>
  readonly openSession: (sessionId: SessionId) => Promise<SessionSnapshot>
  readonly closeSession: (sessionId: SessionId) => Promise<SessionSnapshot>
  readonly getSessionSnapshot: (sessionId: SessionId) => Promise<SessionSnapshot | undefined>
  readonly getRunSnapshot: (runId: RunId) => Promise<RunSnapshot | undefined>
  readonly runTurn: (options: RunTurnOptions) => Promise<RunId>
  readonly resumeRun: (options: ResumeRunOptions) => Promise<RunId>
  readonly streamEvents: (runId: RunId) => AsyncIterable<DomainEvent>
  readonly cancelRun: (runId: RunId) => boolean
}

export interface GraphRunRequest {
  readonly graph: OrchestrationGraph
  readonly initialState?: Record<string, unknown>
  readonly executors: Record<string, unknown>
  readonly sessionId?: SessionId
  readonly runId?: RunId
}

export interface GraphRunHandle {
  readonly sessionId: SessionId
  readonly runId?: RunId
  readonly events: AsyncIterable<DomainEvent>
}

export interface ResumeGraphRunRequest {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly checkpointId?: string
}

export interface CancelGraphRunRequest {
  readonly runId: RunId
}

export interface StreamGraphRunRequest {
  readonly runId: RunId
}

export interface GraphRuntime {
  runGraph(request: GraphRunRequest): Promise<GraphRunHandle>
  resumeGraph(request: ResumeGraphRunRequest): Promise<GraphRunHandle>
  cancelRun(request: CancelGraphRunRequest): Promise<void>
  streamRun(request: StreamGraphRunRequest): AsyncIterable<DomainEvent>
}

export interface GraphRuntimeDeps {
  readonly sessionRuntime: Pick<
    SessionRuntime,
    'createSession' | 'openSession' | 'streamEvents' | 'cancelRun'
  >
  readonly graphRunner?: {
    readonly start?: (request: {
      readonly sessionId: SessionId
      readonly runId: RunId
      readonly graph: OrchestrationGraph
      readonly initialState?: Record<string, unknown>
      readonly executors: Record<string, unknown>
      readonly emitEvent?: (event: DomainEvent) => void | Promise<void>
    }) => Promise<RunId>
    readonly resume?: (request: ResumeGraphRunRequest) => Promise<GraphRunHandle>
  }
}

// ── 内部类型（仅 runtime/ 子模块可见）────────────────────────────────────────

export interface ActiveRun {
  readonly runId: RunId
  readonly sessionId: SessionId
  readonly controller: AbortController
  readonly events: ReplayableEventStream<DomainEvent>
}

export interface ExecuteRunInput {
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

export interface RunExecutionContext {
  readonly signal: AbortSignal
  readonly toolCatalog: ToolCatalog
  readonly sequence: {
    current: number
  }
  readonly pendingOperations: Map<string, RunSnapshot['pendingOperations'][number]>
  readonly destructiveOperationIds: Set<string>
}

export interface AbortSignalScope {
  readonly signal: AbortSignal | undefined
  readonly cleanup: () => void
}

export interface RunLineageFields {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly triggerType: RunSnapshot['triggerType']
  readonly parentRunId?: RunId
}

// TokenUsage は外部から import されるため re-export のみ
export type { TokenUsage }
