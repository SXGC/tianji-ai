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
import type { RunTriggerType } from './snapshot.js'
import type { ToolInvocation, ToolResult } from './tool.js'

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

interface RunLifecycleEventFields {
  readonly runId: RunId
  readonly sessionId: SessionId
  /**
   * Identifies whether this run started fresh or was derived from a prior run.
   */
  readonly triggerType: RunTriggerType
  /**
   * Records the source run when a resume/retry/replay flow creates a new run.
   */
  readonly parentRunId?: RunId
  readonly timestamp: number
}

export interface RunStartedEvent extends RunLifecycleEventFields {
  readonly type: 'run.started'
}

export interface RunCompletedEvent extends RunLifecycleEventFields {
  readonly type: 'run.completed'
}

export interface RunFailedEvent extends RunLifecycleEventFields {
  readonly type: 'run.failed'
  readonly error: TianjiError
}

export interface RunCancelledEvent extends RunLifecycleEventFields {
  readonly type: 'run.cancelled'
}

export interface MessageStartedEvent {
  readonly type: 'message.started'
  readonly runId: RunId
  readonly messageId: string
  readonly message: AppMessage
  readonly timestamp: number
}

export type MessageDeltaChannel = 'text' | 'thinking'

export interface MessageDeltaPayload {
  readonly content: string
}

export interface MessageDeltaEvent {
  readonly type: 'message.delta'
  readonly runId: RunId
  readonly messageId: string
  readonly sequence: number
  readonly channel: MessageDeltaChannel
  readonly payload: MessageDeltaPayload
  readonly timestamp: number
}

export interface MessageCompletedEvent {
  readonly type: 'message.completed'
  readonly runId: RunId
  readonly messageId: string
  readonly message: AppMessage
  readonly timestamp: number
}

export interface ToolStartedEvent {
  readonly type: 'tool.started'
  readonly runId: RunId
  readonly toolCallId: string
  readonly invocation: ToolInvocation
  readonly timestamp: number
}

export interface ToolCompletedEvent {
  readonly type: 'tool.completed'
  readonly runId: RunId
  readonly toolCallId: string
  readonly invocation: ToolInvocation
  readonly result: ToolResult
  readonly timestamp: number
}

export interface ToolFailedEvent {
  readonly type: 'tool.failed'
  readonly runId: RunId
  readonly toolCallId: string
  readonly invocation: ToolInvocation
  readonly error: ToolError
  readonly timestamp: number
}

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
