/**
 * Snapshot types for tianji-ai
 *
 * Defines SessionSnapshot and RunSnapshot contracts for runtime state persistence
 * and cancellation/resume semantics.
 *
 * @module snapshot
 */

import type { RunId, SessionId } from './identifiers.js'
import type { AppMessage } from './message.js'
import type { ExecutionPolicy } from './policy.js'
import type { ToolInvocation } from './tool.js'

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * Describes how a run was created within an execution lineage.
 */
export type RunTriggerType = 'new' | 'resume' | 'retry' | 'replay'

export type PendingOperationStatus =
  | 'running'
  | 'completed'
  | 'aborted-clean'
  | 'aborted-with-side-effect'

export type ResumeHint = 'replay' | 'skip' | 'require-user-confirmation'

export interface PendingOperation {
  readonly id: string
  readonly invocation: ToolInvocation
  readonly status: PendingOperationStatus
  readonly timestamp: number
}

export interface SessionSnapshot {
  readonly sessionId: SessionId
  readonly messages: AppMessage[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly metadata?: Record<string, unknown>
  readonly policy?: ExecutionPolicy
}

export interface RunSnapshot {
  readonly runId: RunId
  readonly sessionId: SessionId
  readonly status: RunStatus
  /**
   * Identifies whether this run started fresh or was derived from a prior run.
   */
  readonly triggerType: RunTriggerType
  /**
   * Records the source run when a resume/retry/replay flow creates a new run.
   */
  readonly parentRunId?: RunId
  readonly messages: AppMessage[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly cancelPoint?: string
  readonly pendingOperations: PendingOperation[]
  readonly resumeHint?: ResumeHint
  readonly workflowState?: unknown
  readonly policy?: ExecutionPolicy
  readonly metadata?: Record<string, unknown>
}
