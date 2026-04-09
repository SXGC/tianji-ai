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

/**
 * Token consumption counters for a single run or accumulated across a session.
 */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  /** 命中缓存的输入 token 数（来自 LangChain input_token_details.cache_read） */
  readonly cacheReadTokens?: number
  /** 创建缓存的输入 token 数（来自 LangChain input_token_details.cache_creation） */
  readonly cacheCreationTokens?: number
}

/**
 * Accumulate two TokenUsage records by summing each field.
 *
 * @param base - Existing accumulated usage (or undefined for the first addition)
 * @param delta - New usage to add
 * @returns Merged TokenUsage with all fields summed
 */
export function addTokenUsage(base: TokenUsage | undefined, delta: TokenUsage): TokenUsage {
  const cacheRead =
    (base?.cacheReadTokens ?? delta.cacheReadTokens)
      ? (base?.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0)
      : undefined
  const cacheCreation =
    (base?.cacheCreationTokens ?? delta.cacheCreationTokens)
      ? (base?.cacheCreationTokens ?? 0) + (delta.cacheCreationTokens ?? 0)
      : undefined

  return {
    inputTokens: (base?.inputTokens ?? 0) + delta.inputTokens,
    outputTokens: (base?.outputTokens ?? 0) + delta.outputTokens,
    totalTokens: (base?.totalTokens ?? 0) + delta.totalTokens,
    ...(cacheRead !== undefined && { cacheReadTokens: cacheRead }),
    ...(cacheCreation !== undefined && { cacheCreationTokens: cacheCreation }),
  }
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
