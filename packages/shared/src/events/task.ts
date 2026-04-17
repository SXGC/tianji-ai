/**
 * Task 聚合领域事件。
 * TaskObservationLost 由 cp 作为观察者发射（spec §四.2 例外）。
 * @module events/task
 */

import type { TianjiError } from '../errors.js'
import type { AppMessage } from '../message.js'
import type { MessageDeltaChannel, MessageDeltaPayload } from './run.js'

interface TaskFields {
  readonly taskId: string
  readonly timestamp: number
}

export interface TaskStartedEvent extends TaskFields {
  readonly type: 'TaskStarted'
}

export interface TaskWaitingEvent extends TaskFields {
  readonly type: 'TaskWaiting'
  readonly reason: string
}

export interface TaskSessionAttachedEvent extends TaskFields {
  readonly type: 'TaskSessionAttached'
  readonly sessionId: string
}

export interface TaskCompletedEvent extends TaskFields {
  readonly type: 'TaskCompleted'
}

export interface TaskFailedEvent extends TaskFields {
  readonly type: 'TaskFailed'
  readonly error: TianjiError
}

export interface TaskCancelledEvent extends TaskFields {
  readonly type: 'TaskCancelled'
}

export interface TaskObservationLostEvent extends TaskFields {
  readonly type: 'TaskObservationLost'
  readonly lastObservedAt: string
}

export interface TaskMessageStartedEvent extends TaskFields {
  readonly type: 'TaskMessageStarted'
  readonly messageId: string
  readonly role: 'assistant'
}

export interface TaskMessageDeltaEvent extends TaskFields {
  readonly type: 'TaskMessageDelta'
  readonly messageId: string
  readonly sequence: number
  readonly channel: MessageDeltaChannel
  readonly payload: MessageDeltaPayload
}

export interface TaskMessageCompletedEvent extends TaskFields {
  readonly type: 'TaskMessageCompleted'
  readonly messageId: string
  readonly message: AppMessage
}

export type TaskDomainEvent =
  | TaskStartedEvent
  | TaskWaitingEvent
  | TaskSessionAttachedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent
  | TaskObservationLostEvent
  | TaskMessageStartedEvent
  | TaskMessageDeltaEvent
  | TaskMessageCompletedEvent
