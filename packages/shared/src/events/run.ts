/**
 * Run 聚合领域事件，含 Message / Tool entity 事件。
 * @module events/run
 */

import type { TianjiError, ToolError } from '../errors.js'
import type { RunId, SessionId } from '../identifiers.js'
import type { AppMessage } from '../message.js'
import type { RunTriggerType } from '../snapshot.js'
import type { ToolInvocation, ToolResult } from '../tool.js'

interface RunLifecycleFields {
  readonly runId: RunId
  readonly sessionId: SessionId
  readonly triggerType: RunTriggerType
  readonly parentRunId?: RunId
  readonly timestamp: number
}

export interface RunStartedEvent extends RunLifecycleFields {
  readonly type: 'RunStarted'
}

export interface RunCompletedEvent extends RunLifecycleFields {
  readonly type: 'RunCompleted'
}

export interface RunFailedEvent extends RunLifecycleFields {
  readonly type: 'RunFailed'
  readonly error: TianjiError
}

export type RunCancelledReason = 'hitl' | 'abort'

export interface RunCancelledEvent extends RunLifecycleFields {
  readonly type: 'RunCancelled'
  readonly reason: RunCancelledReason
}

export type MessageDeltaChannel = 'text' | 'thinking'

export interface MessageDeltaPayload {
  readonly content: string
}

export interface MessageStartedEvent {
  readonly type: 'MessageStarted'
  readonly runId: RunId
  readonly messageId: string
  readonly message: AppMessage
  readonly timestamp: number
}

export interface MessageDeltaEvent {
  readonly type: 'MessageDelta'
  readonly runId: RunId
  readonly messageId: string
  readonly sequence: number
  readonly channel: MessageDeltaChannel
  readonly payload: MessageDeltaPayload
  readonly timestamp: number
}

export interface MessageCompletedEvent {
  readonly type: 'MessageCompleted'
  readonly runId: RunId
  readonly messageId: string
  readonly message: AppMessage
  readonly timestamp: number
}

export interface ToolStartedEvent {
  readonly type: 'ToolStarted'
  readonly runId: RunId
  readonly toolCallId: string
  readonly invocation: ToolInvocation
  readonly timestamp: number
}

export interface ToolCompletedEvent {
  readonly type: 'ToolCompleted'
  readonly runId: RunId
  readonly toolCallId: string
  readonly invocation: ToolInvocation
  readonly result: ToolResult
  readonly timestamp: number
}

export interface ToolFailedEvent {
  readonly type: 'ToolFailed'
  readonly runId: RunId
  readonly toolCallId: string
  readonly invocation: ToolInvocation
  readonly error: ToolError
  readonly timestamp: number
}

export type RunDomainEvent =
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
