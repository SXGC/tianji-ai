/**
 * Runtime event types for tianji-ai
 *
 * Defines the contract for events emitted during runtime execution.
 * Events follow a discriminated union pattern using the `type` field
 * for type-safe event handling.
 *
 * @module events
 */

import type { TianjiError, ToolError } from './errors.js'
import type { RunId, SessionId } from './identifiers.js'
import type { AppMessage } from './message.js'
import type { ToolInvocation, ToolResult } from './tool.js'

// ============================================================================
// Runtime Event Types
// ============================================================================

/**
 * Discriminator types for runtime events.
 *
 * Events are organized into three categories:
 * - Run lifecycle: started, completed, failed, cancelled
 * - Message lifecycle: started, delta, completed
 * - Tool lifecycle: started, completed, failed
 */
export type RuntimeEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'message.started'
  | 'message.delta'
  | 'message.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'

// ============================================================================
// Run Events
// ============================================================================

/**
 * Emitted when a run starts execution.
 */
export interface RunStartedEvent {
  /** Discriminator for run.started event */
  readonly type: 'run.started'
  /** Unique identifier for this run */
  readonly runId: RunId
  /** Session this run belongs to */
  readonly sessionId: SessionId
  /** Unix timestamp (milliseconds) when the run started */
  readonly timestamp: number
}

/**
 * Emitted when a run completes successfully.
 */
export interface RunCompletedEvent {
  /** Discriminator for run.completed event */
  readonly type: 'run.completed'
  /** Unique identifier for this run */
  readonly runId: RunId
  /** Session this run belongs to */
  readonly sessionId: SessionId
  /** Unix timestamp (milliseconds) when the run completed */
  readonly timestamp: number
}

/**
 * Emitted when a run fails with an error.
 */
export interface RunFailedEvent {
  /** Discriminator for run.failed event */
  readonly type: 'run.failed'
  /** Unique identifier for this run */
  readonly runId: RunId
  /** Session this run belongs to */
  readonly sessionId: SessionId
  /** The error that caused the run to fail */
  readonly error: TianjiError
  /** Unix timestamp (milliseconds) when the run failed */
  readonly timestamp: number
}

/**
 * Emitted when a run is cancelled.
 */
export interface RunCancelledEvent {
  /** Discriminator for run.cancelled event */
  readonly type: 'run.cancelled'
  /** Unique identifier for this run */
  readonly runId: RunId
  /** Session this run belongs to */
  readonly sessionId: SessionId
  /** Unix timestamp (milliseconds) when the run was cancelled */
  readonly timestamp: number
}

// ============================================================================
// Message Events
// ============================================================================

/**
 * Emitted when a message starts being generated.
 */
export interface MessageStartedEvent {
  /** Discriminator for message.started event */
  readonly type: 'message.started'
  /** Run this message belongs to */
  readonly runId: RunId
  /** Unique identifier for this message */
  readonly messageId: string
  /** The message being generated (may be partial) */
  readonly message: AppMessage
  /** Unix timestamp (milliseconds) when the message started */
  readonly timestamp: number
}

/**
 * Channel type for message delta content.
 *
 * Different channels represent different types of streaming content
 * within a single message (e.g., text and thinking can interleave).
 */
export type MessageDeltaChannel = 'text' | 'thinking'

/**
 * Minimal delta payload for message streaming.
 *
 * This inline definition provides the essential structure for message deltas.
 * Task 14 will define the complete MessageDelta type with full aggregation support.
 */
export interface MessageDeltaPayload {
  /** The delta content (text for 'text' channel, thinking for 'thinking' channel) */
  readonly content: string
}

/**
 * Emitted for each delta chunk during message streaming.
 *
 * Deltas are ordered by sequence number for proper reassembly.
 * The channel indicates which part of the message is being updated.
 */
export interface MessageDeltaEvent {
  /** Discriminator for message.delta event */
  readonly type: 'message.delta'
  /** Run this message belongs to */
  readonly runId: RunId
  /** Unique identifier for this message */
  readonly messageId: string
  /** Monotonically increasing sequence number for ordering */
  readonly sequence: number
  /** The content channel being updated (text, thinking, etc.) */
  readonly channel: MessageDeltaChannel
  /** The delta payload for this chunk */
  readonly payload: MessageDeltaPayload
  /** Unix timestamp (milliseconds) when the delta was generated */
  readonly timestamp: number
}

/**
 * Emitted when a message is fully generated.
 */
export interface MessageCompletedEvent {
  /** Discriminator for message.completed event */
  readonly type: 'message.completed'
  /** Run this message belongs to */
  readonly runId: RunId
  /** Unique identifier for this message */
  readonly messageId: string
  /** The complete message */
  readonly message: AppMessage
  /** Unix timestamp (milliseconds) when the message completed */
  readonly timestamp: number
}

// ============================================================================
// Tool Events
// ============================================================================

/**
 * Emitted when a tool execution starts.
 */
export interface ToolStartedEvent {
  /** Discriminator for tool.started event */
  readonly type: 'tool.started'
  /** Run this tool call belongs to */
  readonly runId: RunId
  /** Unique identifier for this tool call */
  readonly toolCallId: string
  /** The tool invocation details */
  readonly invocation: ToolInvocation
  /** Unix timestamp (milliseconds) when the tool started */
  readonly timestamp: number
}

/**
 * Emitted when a tool execution completes successfully.
 */
export interface ToolCompletedEvent {
  /** Discriminator for tool.completed event */
  readonly type: 'tool.completed'
  /** Run this tool call belongs to */
  readonly runId: RunId
  /** Unique identifier for this tool call */
  readonly toolCallId: string
  /** The tool execution result */
  readonly result: ToolResult
  /** Unix timestamp (milliseconds) when the tool completed */
  readonly timestamp: number
}

/**
 * Emitted when a tool execution fails.
 */
export interface ToolFailedEvent {
  /** Discriminator for tool.failed event */
  readonly type: 'tool.failed'
  /** Run this tool call belongs to */
  readonly runId: RunId
  /** Unique identifier for this tool call */
  readonly toolCallId: string
  /** The tool invocation that failed */
  readonly invocation: ToolInvocation
  /** The error that caused the tool to fail */
  readonly error: ToolError
  /** Unix timestamp (milliseconds) when the tool failed */
  readonly timestamp: number
}

// ============================================================================
// Runtime Event Union
// ============================================================================

/**
 * Union type of all runtime events.
 *
 * Use discriminated union narrowing with the `type` field to handle
 * specific event types in a type-safe manner.
 *
 * @example
 * ```typescript
 * function handleEvent(event: RuntimeEvent) {
 *   switch (event.type) {
 *     case 'run.started':
 *       console.log('Run started:', event.runId)
 *       break
 *     case 'message.delta':
 *       console.log('Delta:', event.payload.content)
 *       break
 *     case 'tool.completed':
 *       console.log('Tool result:', event.result)
 *       break
 *     // ... handle other event types
 *   }
 * }
 * ```
 */
export type RuntimeEvent =
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
