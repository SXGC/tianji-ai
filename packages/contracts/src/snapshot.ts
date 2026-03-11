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
	/** Unique identifier for this operation */
	readonly id: string
	/** Tool invocation that triggered this operation */
	readonly invocation: ToolInvocation
	/** Current status of this operation */
	readonly status: PendingOperationStatus
	/** Unix timestamp when the operation was recorded */
	readonly timestamp: number
}

export interface SessionSnapshot {
	/** Unique identifier for this session */
	readonly sessionId: SessionId
	/** Messages in this session */
	readonly messages: AppMessage[]
	/** Unix timestamp when the snapshot was created */
	readonly createdAt: number
	/** Unix timestamp when the snapshot was last updated */
	readonly updatedAt: number
	/** Optional metadata for additional context */
	readonly metadata?: Record<string, unknown>
	/** Optional execution policy for this session */
	readonly policy?: ExecutionPolicy
}

export interface RunSnapshot {
	/** Unique identifier for this run */
	readonly runId: RunId
	/** Session this run belongs to */
	readonly sessionId: SessionId
	/** Current status of this run */
	readonly status: RunStatus
	/** Messages in this run */
	readonly messages: AppMessage[]
	/** Unix timestamp when the run started */
	readonly createdAt: number
	/** Unix timestamp when the snapshot was last updated */
	readonly updatedAt: number
	/** Optional point in workflow where cancellation occurred */
	readonly cancelPoint?: string
	/** List of pending operations at cancellation time */
	readonly pendingOperations: PendingOperation[]
	/** Hint for how to resume the run after cancellation */
	readonly resumeHint?: ResumeHint
	/** Optional workflow-specific state (opaque, framework-specific) */
	readonly workflowState?: unknown
	/** Optional execution policy for this run */
	readonly policy?: ExecutionPolicy
	/** Optional metadata for additional context */
	readonly metadata?: Record<string, unknown>
}
