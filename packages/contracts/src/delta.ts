/**
 * Delta types for tianji-ai
 *
 * Defines the contract for incremental updates during streaming.
 * Deltas represent small chunks of content that can be aggregated
 * into complete messages or tool results.
 *
 * @module delta
 */

import type { MessageDeltaChannel } from './events.js'
import type { RunId } from './identifiers.js'

// ============================================================================
// Delta Operation Types
// ============================================================================

/**
 * Operation type for delta updates.
 *
 * - 'append': Add content to the end of existing content
 * - 'replace': Replace existing content with new content
 * - 'complete': Signal that the stream is complete
 */
export type DeltaOp = 'append' | 'replace' | 'complete'

// ============================================================================
// Message Delta Types
// ============================================================================

// Note: MessageDeltaChannel is imported from events.js to avoid duplicate export

/**
 * Delta for incremental message content updates.
 *
 * MessageDelta represents a chunk of content being streamed for a message.
 * Multiple deltas with increasing sequence numbers are aggregated to form
 * the complete message content.
 *
 * The aggregation rules:
 * - 'append': Concatenate payload to existing content for the channel
 * - 'replace': Replace all content for the channel with payload
 * - 'complete': Signal that no more deltas will arrive for this message
 *
 * @example
 * ```typescript
 * const delta: MessageDelta = {
 *   runId: createRunId('run_123'),
 *   messageId: 'msg_001',
 *   sequence: 1,
 *   op: 'append',
 *   channel: 'text',
 *   payload: 'Hello',
 *   timestamp: Date.now(),
 * }
 * ```
 */
export interface MessageDelta {
  /** Run this message belongs to */
  readonly runId: RunId
  /** Unique identifier for this message */
  readonly messageId: string
  /** Monotonically increasing sequence number for ordering */
  readonly sequence: number
  /** Operation to perform with this delta */
  readonly op: DeltaOp
  /** The content channel being updated (text, thinking, etc.) */
  readonly channel: MessageDeltaChannel
  /** The delta content (interpretation depends on channel and op) */
  readonly payload: unknown
  /** Unix timestamp (milliseconds) when the delta was generated */
  readonly timestamp: number
}

// ============================================================================
// Tool Progress Delta Types
// ============================================================================

/**
 * Channel type for tool progress updates.
 *
 * Different channels represent different types of progress information
 * during tool execution.
 */
export type ToolProgressChannel = 'stdout' | 'stderr' | 'progress' | 'result'

/**
 * Delta for incremental tool execution progress.
 *
 * ToolProgressDelta represents progress updates during tool execution.
 * These can include stdout/stderr output, progress indicators, or
 * partial results before the tool completes.
 *
 * The aggregation rules:
 * - 'append': Concatenate payload to existing content for the channel
 * - 'replace': Replace all content for the channel with payload
 * - 'complete': Signal that tool execution is complete
 *
 * @example
 * ```typescript
 * const delta: ToolProgressDelta = {
 *   runId: createRunId('run_123'),
 *   toolCallId: 'call_001',
 *   sequence: 1,
 *   op: 'append',
 *   channel: 'stdout',
 *   payload: 'Processing file 1/10...',
 *   timestamp: Date.now(),
 * }
 * ```
 */
export interface ToolProgressDelta {
  /** Run this tool call belongs to */
  readonly runId: RunId
  /** Unique identifier for this tool call */
  readonly toolCallId: string
  /** Monotonically increasing sequence number for ordering */
  readonly sequence: number
  /** Operation to perform with this delta */
  readonly op: DeltaOp
  /** The content channel being updated (stdout, stderr, progress, result) */
  readonly channel: ToolProgressChannel
  /** The delta content (interpretation depends on channel and op) */
  readonly payload: unknown
  /** Unix timestamp (milliseconds) when the delta was generated */
  readonly timestamp: number
}

// ============================================================================
// Delta Union Type
// ============================================================================

/**
 * Union type of all delta types.
 *
 * Use type guards or discriminated union narrowing to handle
 * specific delta types in a type-safe manner.
 *
 * Note: MessageDelta and ToolProgressDelta can be distinguished by
 * the presence of `messageId` vs `toolCallId`.
 */
export type Delta = MessageDelta | ToolProgressDelta
