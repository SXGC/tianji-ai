import type { DomainEvent, RunId, SessionId } from '@tianji/shared'

import type { AgentExecutorFactory, OrchestrationGraph } from './orchestration/index.js'

export type UnifiedEntrySource = 'controlplane' | 'cli' | 'daemon' | 'acp'

export interface UnifiedEventObserver {
  readonly onEvent?: (event: DomainEvent) => void | Promise<void>
}

export interface UnifiedRunRequest {
  readonly source: UnifiedEntrySource
  readonly agentId?: string
  readonly input: string
  readonly sessionId?: SessionId
  readonly graph?: OrchestrationGraph
  readonly observer?: UnifiedEventObserver
}

export interface UnifiedResumeRequest {
  readonly source: UnifiedEntrySource
  readonly sessionId: SessionId
  readonly runId?: RunId
  readonly checkpointId?: string
  readonly observer?: UnifiedEventObserver
}

export interface UnifiedCancelRequest {
  readonly source: UnifiedEntrySource
  readonly runId: RunId
}

export interface UnifiedStreamRequest {
  readonly source: UnifiedEntrySource
  readonly runId: RunId
}

export interface UnifiedRunHandle {
  readonly sessionId?: SessionId
  readonly runId?: RunId
  readonly events: AsyncIterable<DomainEvent>
}

export interface UnifiedRuntimeEntry {
  run(request: UnifiedRunRequest): Promise<UnifiedRunHandle>
  resume(request: UnifiedResumeRequest): Promise<UnifiedRunHandle>
  cancel(request: UnifiedCancelRequest): Promise<void>
  stream(request: UnifiedStreamRequest): AsyncIterable<DomainEvent>
}

export interface UnifiedRuntimeAdapter {
  runGraph(request: {
    readonly request: UnifiedRunRequest
    readonly graph: OrchestrationGraph
    readonly executors: AgentExecutorFactory
  }): Promise<UnifiedRunHandle>
  resumeGraph(request: UnifiedResumeRequest): Promise<UnifiedRunHandle>
  cancelRun(request: UnifiedCancelRequest): Promise<void>
  streamRun(request: UnifiedStreamRequest): AsyncIterable<DomainEvent>
}

export interface UnifiedEntryDeps {
  readonly loadDefaultGraph: (request: UnifiedRunRequest) => Promise<OrchestrationGraph>
  readonly createExecutorRegistry: (
    request: UnifiedRunRequest
  ) => Promise<AgentExecutorFactory> | AgentExecutorFactory
  readonly runtime: UnifiedRuntimeAdapter
}
