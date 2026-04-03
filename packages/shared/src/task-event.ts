/**
 * Task event types for V3 distributed control plane.
 *
 * TaskEvent 是 node 向 controlplane 上报的事件协议。
 * 分为两类：lifecycle（task 生命周期）和 agent（RuntimeEvent 透传）。
 *
 * @module task-event
 */

import type { RuntimeEvent } from './events.js'
import type { RunId, SessionId, TaskId } from './identifiers.js'

export const TASK_STATUSES = [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'observation_lost',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'observation_lost',
])

/** 判断 task 状态是否为确定性终态 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

export const TASK_LIFECYCLE_TYPES = [
  'task.started',
  'task.waiting',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.session.attached',
] as const

export type TaskLifecycleType = (typeof TASK_LIFECYCLE_TYPES)[number]

/** Node 生成的 task 生命周期事件 */
export interface TaskLifecycleEvent {
  readonly kind: 'lifecycle'
  readonly taskId: TaskId
  readonly type: TaskLifecycleType
  /** 单调递增序列号，用于去重和排序 */
  readonly sequence: number
  /** Unix 毫秒时间戳 */
  readonly timestamp: number
  readonly sessionId?: SessionId
  readonly runId?: RunId
  readonly summary?: string
  /** task.failed 时携带的错误信息 */
  readonly error?: string
}

/** Agent 产出的 RuntimeEvent 透传包装 */
export interface TaskAgentEvent {
  readonly kind: 'agent'
  readonly taskId: TaskId
  /** 与 lifecycle 事件共享同一递增序列 */
  readonly sequence: number
  readonly sessionId: SessionId
  readonly runId: RunId
  /** 原样透传的 RuntimeEvent */
  readonly event: RuntimeEvent
}

/** TaskEvent 联合类型，NDJSON 流中每行一个 */
export type TaskEvent = TaskLifecycleEvent | TaskAgentEvent
