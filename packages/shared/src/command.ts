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

/**
 * task.cancel 指令的 payload。
 * 目前只支持用户主动取消一个方向；reason 留扩展空间，未来可补 'timeout' / 'admin' 等。
 */
export interface TaskCancelPayload {
  readonly taskId: TaskId
  readonly reason: 'user'
}

/** Command 的共享字段，所有命令子类型都继承这里的元数据。 */
interface CommandBase {
  readonly commandId: CommandId
  readonly nodeId: NodeId
  readonly state: CommandState
  readonly leasedAt?: number
  readonly completedAt?: number
  readonly createdAt: number
}

/** task.run：请求在目标 node 上启动一个新任务。 */
export interface TaskRunCommand extends CommandBase {
  readonly type: 'task.run'
  readonly payload: TaskRunPayload
}

/** task.cancel：请求目标 node 取消正在执行的任务。 */
export interface TaskCancelCommand extends CommandBase {
  readonly type: 'task.cancel'
  readonly payload: TaskCancelPayload
}

/** 控制平面下发给 node 的指令（discriminated union：按 `type` 收缩到具体 payload 形状）。 */
export type Command = TaskRunCommand | TaskCancelCommand

/** 长轮询返回给 node 的指令（精简版，不含内部状态字段）。 */
export type PollCommandResponse =
  | { readonly commandId: CommandId; readonly type: 'task.run'; readonly payload: TaskRunPayload }
  | {
      readonly commandId: CommandId
      readonly type: 'task.cancel'
      readonly payload: TaskCancelPayload
    }
