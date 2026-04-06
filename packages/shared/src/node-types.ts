/**
 * Node and Agent metadata types for V3 distributed architecture.
 *
 * 定义 node 注册、心跳、agent 列表等 node <-> controlplane 通信的数据结构。
 *
 * @module node-types
 */

import type { NodeId } from './identifiers.js'

export const NODE_EXECUTION_STATES = ['idle', 'busy'] as const
export type NodeExecutionState = (typeof NODE_EXECUTION_STATES)[number]

export const NODE_STATUSES = ['online', 'offline'] as const
export type NodeStatus = (typeof NODE_STATUSES)[number]

/** Node 上报的 agent 元数据 */
export interface AgentInfo {
  readonly agentId: string
  readonly type: 'native' | 'third-party'
  readonly name: string
  readonly version: string
}

/** Node 注册请求 body */
export interface NodeRegisterRequest {
  readonly nodeId: NodeId
  readonly enrollmentToken: string
  readonly hostname: string
  readonly platform: string
  readonly version: string
  readonly agentList: readonly AgentInfo[]
  readonly pid?: number
}

/** Node 注册响应 */
export interface NodeRegisterResponse {
  readonly accessToken: string
  /** Token 过期时间（unix 毫秒） */
  readonly expiresAt: number
}

/** Node 心跳请求 body */
export interface NodeHeartbeatRequest {
  readonly executionState: NodeExecutionState
  /** 仅在本地 agent 配置变更时携带全量快照 */
  readonly agentList?: readonly AgentInfo[]
  readonly pid?: number
}
