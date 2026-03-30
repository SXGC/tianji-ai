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
