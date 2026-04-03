/**
 * Command types for V3 control plane -> node communication.
 *
 * Command 是控制平面下发给 node 的指令。Node 通过长轮询获取 pending command。
 *
 * @module command
 */

import type { CommandId, NodeId, SessionId, TaskId } from './identifiers.js'

export const COMMAND_STATES = [
  'pending',
  'leased',
  'running',
  'completed',
  'failed',
  'observation_lost',
] as const

export type CommandState = (typeof COMMAND_STATES)[number]

const TERMINAL_COMMAND_STATES: ReadonlySet<CommandState> = new Set([
  'completed',
  'failed',
  'observation_lost',
])

/** 判断 command 状态是否为终态 */
export function isTerminalCommandState(state: CommandState): boolean {
  return TERMINAL_COMMAND_STATES.has(state)
}

/** task.run 指令的 payload */
export interface TaskRunPayload {
  readonly taskId: TaskId
  readonly agentId: string
  readonly goal: string
  /** 可选的已有会话引用；缺失表示 agent 自行创建/选择 session */
  readonly sessionIds?: readonly SessionId[]
}

/** 控制平面下发给 node 的指令 */
export interface Command {
  readonly commandId: CommandId
  readonly nodeId: NodeId
  readonly type: 'task.run'
  readonly payload: TaskRunPayload
  readonly state: CommandState
  readonly leasedAt?: number
  readonly completedAt?: number
  readonly createdAt: number
}

/** 长轮询返回给 node 的指令（精简版，不含内部状态字段） */
export interface PollCommandResponse {
  readonly commandId: CommandId
  readonly type: 'task.run'
  readonly payload: TaskRunPayload
}
