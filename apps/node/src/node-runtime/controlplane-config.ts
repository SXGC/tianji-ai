import { hostname, platform } from 'node:os'

import {
  type AgentInfo,
  type NodeId,
  type TianjiConfig,
  createNodeId,
  resolveAgentType,
} from '@tianji/shared'

/**
 * 持久化存储的 control plane 连接配置。
 */
export interface StoredControlPlaneConfig {
  readonly baseUrl: string
  readonly enrollmentToken: string
  readonly nodeId: NodeId
  readonly hostname: string
  readonly platform: string
  readonly version: string
}

/**
 * 从 baseUrl 和 enrollmentToken 构建完整的 StoredControlPlaneConfig，
 * 其余字段从环境变量或系统默认值获取。
 *
 * @param input - 包含 baseUrl 和 enrollmentToken 的最小输入
 * @returns 完整的 StoredControlPlaneConfig
 */
export function buildStoredControlPlaneConfig(input: {
  baseUrl: string
  enrollmentToken: string
}): StoredControlPlaneConfig {
  return {
    baseUrl: input.baseUrl,
    enrollmentToken: input.enrollmentToken,
    nodeId: createNodeId(process.env.TIANJI_NODE_ID ?? hostname()),
    hostname: process.env.TIANJI_NODE_HOSTNAME ?? hostname(),
    platform: process.env.TIANJI_NODE_PLATFORM ?? platform(),
    version: process.env.TIANJI_NODE_VERSION ?? '0.0.1',
  }
}

/**
 * 比较两个 control plane 配置是否在关键字段上一致。
 *
 * @param left - 第一个配置
 * @param right - 第二个配置
 * @returns 当 baseUrl 和 enrollmentToken 都相同时返回 true
 */
export function areStoredControlPlaneConfigsEqual(
  left: Pick<StoredControlPlaneConfig, 'baseUrl' | 'enrollmentToken'>,
  right: Pick<StoredControlPlaneConfig, 'baseUrl' | 'enrollmentToken'>
): boolean {
  return left.baseUrl === right.baseUrl && left.enrollmentToken === right.enrollmentToken
}

/**
 * 从已加载的 TianjiConfig 中读取持久化的 control plane 配置。
 *
 * @param config - 部分加载的 TianjiConfig
 * @returns 解析后的 StoredControlPlaneConfig，若缺少关键字段则返回 null
 */
export function readStoredControlPlaneConfig(
  config: Partial<TianjiConfig>
): StoredControlPlaneConfig | null {
  const cp = config.controlPlane
  if (!cp?.baseUrl || !cp.enrollmentToken) return null
  return {
    baseUrl: cp.baseUrl,
    enrollmentToken: cp.enrollmentToken,
    nodeId: createNodeId(cp.nodeId ?? hostname()),
    hostname: cp.hostname ?? hostname(),
    platform: cp.platform ?? platform(),
    version: cp.version ?? '0.0.1',
  }
}

/**
 * 从最终配置中的 agents.items 派生 controlplane 注册使用的 agent 列表。
 *
 * @param config - 已加载的 Tianji 配置
 * @param nodeVersion - 当前 node 版本，用于填充 agent version
 * @returns 可注册到 controlplane 的 agent 列表
 */
export function deriveControlPlaneAgentList(
  config: Partial<TianjiConfig>,
  nodeVersion: string
): readonly AgentInfo[] {
  const items = config.agents?.items
  if (items === undefined) {
    throw new Error('Missing agents.items in Tianji config')
  }

  return Object.entries(items).map(([agentId, agentConfig]) => ({
    agentId,
    type: resolveAgentType(agentConfig) === 'external' ? 'third-party' : 'native',
    name: agentId,
    version: nodeVersion,
  }))
}
