/**
 * Task 聚合领域事件。
 * TaskObservationLost 由 cp 作为观察者发射（spec §四.2 例外）。
 * @module events/task
 */

import type { TianjiError } from '../errors.js'

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

export type TaskDomainEvent =
  | TaskStartedEvent
  | TaskWaitingEvent
  | TaskSessionAttachedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskCancelledEvent
  | TaskObservationLostEvent
