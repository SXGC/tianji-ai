/**
 * MCP 共享契约。
 *
 * 这里只放纯类型，不放运行时执行逻辑。
 * 语义上分两层：
 * - graph-run 级别的能力上限，声明整个运行过程最多能做什么
 * - 节点级别的 allowlist，声明某个节点实际能访问哪些 MCP 目标
 */

import type { JSONSchema } from './tool.js'

/**
 * MCP tool 的模型可见摘要。
 */
export interface McpToolSummary {
  readonly name: string
  readonly qualifiedName: string
  readonly description?: string
  readonly requiredParameters: readonly string[]
  readonly optionalParameterCount: number
  readonly schema?: JSONSchema
}

/**
 * MCP server 的最小摘要。
 */
export interface McpServerSummary {
  readonly target: string
  readonly name: string
  readonly description?: string
  readonly tools: readonly McpToolSummary[]
}

/**
 * `call_mcp` 输入。
 *
 * `discover` 用来读取某个 server 的能力信息；
 * `invoke` 用来对某个 `server.tool` 发起结构化调用。
 */
export type CallMcpInput = CallMcpDiscoverInput | CallMcpInvokeInput

export interface CallMcpDiscoverInput {
  readonly action: 'discover'
  /** server，例如 `github`。 */
  readonly target: string
  readonly schema?: boolean
  readonly allParameters?: boolean
}

export interface CallMcpInvokeInput {
  readonly action: 'invoke'
  /** `server.tool`，例如 `github.list_pull_requests`。 */
  readonly target: string
  readonly arguments: Record<string, unknown>
  readonly timeoutMs?: number
}

/**
 * `call_mcp discover` 的结果。
 *
 * 返回单个 server 的摘要信息与工具摘要列表。
 */
export interface CallMcpDiscoverResult {
  readonly target: string
  readonly server: string
  readonly description?: string
  readonly tools: readonly McpToolSummary[]
}

/**
 * `call_mcp invoke` 的结果。
 */
export interface CallMcpInvokeResult {
  readonly target: string
  readonly server: string
  readonly tool: string
  readonly content: unknown
  readonly structuredContent?: unknown
  readonly isError: boolean
}

/**
 * graph-run 级别的 MCP 能力上限。
 *
 * 这里声明的是显式 allowlist，不是 hint，也不是默认全开；
 * 默认必须是空集合，由运行时显式注入。
 */
export interface GraphRunCapabilityUpperBound {
  readonly skills: readonly string[]
  readonly tools: readonly string[]
  readonly mcpTargets: readonly string[]
}

/**
 * 节点最终可用的能力集合。
 *
 * 这是 graph-run 上限和节点 allowlist 计算后的结果。
 */
export interface ResolvedNodeCapabilities {
  readonly skills: readonly string[]
  readonly tools: readonly string[]
  readonly mcpTargets: readonly string[]
}
