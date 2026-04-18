/**
 * graph-run 能力解析器。
 *
 * 这里只处理纯数据，不接 graph compiler / executor。
 * 语义很直接：
 * - graph-run 上限是显式 allowlist，默认空集合
 * - 节点声明必须是上限子集
 * - 未声明的节点能力不会自动继承上限
 */

import type { GraphRunCapabilityUpperBound, ResolvedNodeCapabilities } from '@tianji/shared'
import type { AgentNode } from './graph-schema.js'

const CAPABILITY_KEYS = ['skills', 'tools', 'mcpTargets'] as const
type CapabilityKey = (typeof CAPABILITY_KEYS)[number]
/**
 * 当前 AgentNode.agent 里允许存在、但不属于 capability declaration 的字段。
 *
 * 这里故意显式列出来，让 schema 扩展时必须同步更新 resolver，而不是静默放过。
 */
const NON_CAPABILITY_AGENT_KEYS = ['model', 'systemPrompt', 'subagents'] as const

export interface CreateGraphRunCapabilityUpperBoundOptions {
  readonly skills?: readonly string[]
  readonly tools?: readonly string[]
  readonly mcpTargets?: readonly string[]
}

interface NodeCapabilityDeclaration {
  readonly skills?: readonly string[]
  readonly tools?: readonly string[]
  readonly mcpTargets?: readonly string[]
  readonly [key: string]: unknown
}

/**
 * 构建 graph-run 级别的能力上限。
 *
 * 未显式提供时返回空 allowlist，不做任何“默认全开”推断。
 */
export function createGraphRunCapabilityUpperBound(
  options: CreateGraphRunCapabilityUpperBoundOptions = {}
): GraphRunCapabilityUpperBound {
  return {
    skills: copyCapabilityList(options.skills),
    tools: copyCapabilityList(options.tools),
    mcpTargets: copyCapabilityList(options.mcpTargets),
  }
}

/**
 * 解析节点最终可用能力。
 *
 * 节点没声明的能力保持为空，不会从 upper bound 自动继承。
 */
export function resolveNodeCapabilities(
  node: AgentNode,
  upperBound: GraphRunCapabilityUpperBound
): ResolvedNodeCapabilities {
  const declaredCapabilities = node.agent as NodeCapabilityDeclaration
  assertNodeCapabilitiesWithinUpperBound(declaredCapabilities, upperBound)
  return {
    skills: copyCapabilityList(node.agent.skills),
    tools: copyCapabilityList(node.agent.tools),
    mcpTargets: copyCapabilityList(node.agent.mcpTargets),
  }
}

/**
 * 校验节点声明是否完全落在 graph-run 上限内。
 *
 * 规则：
 * - 未声明的字段视为空集合
 * - 声明了不支持的 capability key 直接抛错
 * - 声明了但不在 upper bound 内的值直接抛错
 */
export function assertNodeCapabilitiesWithinUpperBound(
  declared: NodeCapabilityDeclaration,
  upperBound: GraphRunCapabilityUpperBound
): void {
  for (const key of Object.keys(declared)) {
    if (isNonCapabilityAgentKey(key)) {
      continue
    }
    if (!isCapabilityKey(key)) {
      throw new Error(`Unknown capability declaration: ${key}`)
    }
  }

  assertCapabilitySubset('skills', declared.skills, upperBound.skills)
  assertCapabilitySubset('tools', declared.tools, upperBound.tools)
  assertCapabilitySubset('mcpTargets', declared.mcpTargets, upperBound.mcpTargets)
}

function copyCapabilityList(value: readonly string[] | undefined): readonly string[] {
  return value === undefined ? [] : [...value]
}

function assertCapabilitySubset(
  key: CapabilityKey,
  declared: readonly string[] | undefined,
  upperBound: readonly string[]
): void {
  const allowed = new Set(upperBound)
  for (const item of declared ?? []) {
    if (!allowed.has(item)) {
      throw new Error(`Capability ${key} is outside graph-run upper bound: ${item}`)
    }
  }
}

function isCapabilityKey(value: string): value is CapabilityKey {
  return CAPABILITY_KEYS.includes(value as CapabilityKey)
}

function isNonCapabilityAgentKey(value: string): boolean {
  return NON_CAPABILITY_AGENT_KEYS.includes(value as (typeof NON_CAPABILITY_AGENT_KEYS)[number])
}
