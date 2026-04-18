/**
 * call_mcp 工具。
 *
 * 这里不绑定真实 MCP SDK,只把输入协议、授权边界和注入点钉死:
 * - discover 只接受 server 目标
 * - invoke 只接受 server.tool 目标
 * - node tools / node mcpTargets / graph-run 上限 / 只读策略都必须先通过校验
 */
import type { RuntimeToolDefinition, RuntimeToolExecutionContext } from '@tianji/runtime'
import type {
  CallMcpDiscoverResult,
  CallMcpInput,
  CallMcpInvokeResult,
  GraphRunCapabilityUpperBound,
  McpServerSummary,
  ResolvedNodeCapabilities,
} from '@tianji/shared'

export interface CallMcpTargetPolicy {
  readonly sideEffect: 'none' | 'idempotent' | 'destructive'
}

export interface CallMcpExecutionCapabilities {
  readonly nodeCapabilities: ResolvedNodeCapabilities
  readonly graphRunUpperBound: GraphRunCapabilityUpperBound
  readonly readonlyInvokeTargets?: readonly string[]
  readonly targetPolicies?: Readonly<Record<string, CallMcpTargetPolicy>>
}

export interface CallMcpToolOptions {
  readonly getCapabilities: () => CallMcpExecutionCapabilities
  readonly listServers: () => readonly McpServerSummary[]
  readonly discoverMcp: (
    target: string,
    options: {
      readonly schema?: boolean
      readonly allParameters?: boolean
      readonly executionContext: RuntimeToolExecutionContext
    }
  ) => Promise<CallMcpDiscoverResult>
  readonly invokeMcp: (
    target: string,
    args: Record<string, unknown>,
    options: {
      readonly timeoutMs?: number
      readonly executionContext: RuntimeToolExecutionContext
    }
  ) => Promise<CallMcpInvokeResult>
}

type CallMcpDiscoverInput = Extract<CallMcpInput, { readonly action: 'discover' }>
type CallMcpInvokeInput = Extract<CallMcpInput, { readonly action: 'invoke' }>

interface MpcCatalogIndex {
  readonly serverTargets: ReadonlySet<string>
  readonly toolTargets: ReadonlySet<string>
}

const CALL_MCP_TOOL_NAME = 'call_mcp'

/**
 * 构造 call_mcp 工具定义。
 *
 * 运行时只负责授权与参数校验,真实 discover / invoke 行为由注入函数提供。
 */
export function createCallMcpTool(options: CallMcpToolOptions): RuntimeToolDefinition {
  return {
    spec: {
      name: CALL_MCP_TOOL_NAME,
      description:
        '按严格结构化协议调用 MCP。discover 只接受 server，invoke 只接受精确的 server.tool，且只允许白名单只读 target。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['discover', 'invoke'],
          },
          target: {
            type: 'string',
            description: 'discover 时是 server；invoke 时是精确的 server.tool',
          },
          schema: {
            type: 'boolean',
          },
          allParameters: {
            type: 'boolean',
          },
          arguments: {
            type: 'object',
            description: 'invoke 时必须是结构化对象，不能是 CLI 风格字符串',
          },
          timeoutMs: {
            type: 'number',
          },
        },
        required: ['action', 'target'],
      },
    },
    sideEffect: 'idempotent',
    execute: async (args, executionContext): Promise<unknown> => {
      const input = parseCallMcpInput(args)
      const capabilities = options.getCapabilities()
      assertCallMcpIsEnabled(capabilities.nodeCapabilities, capabilities.graphRunUpperBound)

      const index = buildMcpCatalogIndex(options.listServers())
      const effectiveTargets = intersectTargets(
        capabilities.nodeCapabilities.mcpTargets,
        capabilities.graphRunUpperBound.mcpTargets
      )

      if (input.action === 'discover') {
        assertDiscoverAllowed(input, index, effectiveTargets, capabilities.nodeCapabilities)
        return options.discoverMcp(input.target, {
          schema: input.schema,
          allParameters: input.allParameters,
          executionContext,
        })
      }

      assertInvokeAllowed(input, index, effectiveTargets, capabilities)
      return options.invokeMcp(input.target, input.arguments, {
        timeoutMs: input.timeoutMs,
        executionContext,
      })
    },
  }
}

function parseCallMcpInput(args: unknown): CallMcpInput {
  if (!isPlainObject(args)) {
    throw new Error('call_mcp args must be a structured object')
  }

  const action = args.action
  const target = args.target

  if (action !== 'discover' && action !== 'invoke') {
    throw new Error('call_mcp args.action must be discover or invoke')
  }

  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('call_mcp args.target must be a non-empty string')
  }

  if (action === 'discover') {
    return {
      action,
      target,
      schema:
        args.schema === undefined ? undefined : assertBoolean('call_mcp args.schema', args.schema),
      allParameters:
        args.allParameters === undefined
          ? undefined
          : assertBoolean('call_mcp args.allParameters', args.allParameters),
    }
  }

  const invocationArguments = args.arguments
  if (!isPlainObject(invocationArguments)) {
    throw new Error('call_mcp arguments must be a structured object')
  }

  return {
    action,
    target,
    arguments: invocationArguments,
    timeoutMs:
      args.timeoutMs === undefined
        ? undefined
        : assertPositiveFiniteNumber('call_mcp args.timeoutMs', args.timeoutMs),
  }
}

function assertCallMcpIsEnabled(
  nodeCapabilities: ResolvedNodeCapabilities,
  graphRunUpperBound: GraphRunCapabilityUpperBound
): void {
  if (!nodeCapabilities.tools.includes(CALL_MCP_TOOL_NAME)) {
    throw new Error('call_mcp is not enabled on this node')
  }
  assertCapabilitySubset('tools', nodeCapabilities.tools, graphRunUpperBound.tools)
  assertCapabilitySubset('mcpTargets', nodeCapabilities.mcpTargets, graphRunUpperBound.mcpTargets)
}

function assertCapabilitySubset(
  key: 'tools' | 'mcpTargets',
  declared: readonly string[],
  upperBound: readonly string[]
): void {
  const allowed = new Set(upperBound)
  for (const item of declared) {
    if (!allowed.has(item)) {
      throw new Error(`Capability ${key} is outside graph-run upper bound: ${item}`)
    }
  }
}

function assertDiscoverAllowed(
  input: CallMcpDiscoverInput,
  index: MpcCatalogIndex,
  effectiveTargets: ReadonlySet<string>,
  nodeCapabilities: ResolvedNodeCapabilities
): void {
  if (!index.serverTargets.has(input.target)) {
    throw new Error('call_mcp discover target must be a server target')
  }

  if (!effectiveTargets.has(input.target)) {
    throw new Error(`call_mcp target is not authorized by node mcpTargets: ${input.target}`)
  }

  if (!nodeCapabilities.mcpTargets.includes(input.target)) {
    throw new Error(`call_mcp target is not available on this node: ${input.target}`)
  }
}

function assertInvokeAllowed(
  input: CallMcpInvokeInput,
  index: MpcCatalogIndex,
  effectiveTargets: ReadonlySet<string>,
  capabilities: CallMcpExecutionCapabilities
): void {
  if (!index.toolTargets.has(input.target)) {
    throw new Error('call_mcp invoke target must be a server.tool target')
  }

  if (!isAuthorizedInvokeTarget(input.target, index, effectiveTargets)) {
    throw new Error(`call_mcp target is not authorized by node mcpTargets: ${input.target}`)
  }

  if (!isReadonlyInvokeTarget(input.target, capabilities)) {
    throw new Error(`call_mcp invoke target is blocked by the readonly allowlist: ${input.target}`)
  }
}

function isAuthorizedInvokeTarget(
  target: string,
  index: MpcCatalogIndex,
  effectiveTargets: ReadonlySet<string>
): boolean {
  if (effectiveTargets.has(target)) {
    return true
  }

  for (const allowedTarget of effectiveTargets) {
    if (!index.serverTargets.has(allowedTarget)) {
      continue
    }
    if (target.startsWith(`${allowedTarget}.`)) {
      return true
    }
  }

  return false
}

function isReadonlyInvokeTarget(
  target: string,
  capabilities: CallMcpExecutionCapabilities
): boolean {
  const policy = capabilities.targetPolicies?.[target]
  if (policy !== undefined) {
    return policy.sideEffect === 'none'
  }

  return capabilities.readonlyInvokeTargets?.includes(target) === true
}

function buildMcpCatalogIndex(servers: readonly McpServerSummary[]): MpcCatalogIndex {
  const serverTargets = new Set<string>()
  const toolTargets = new Set<string>()

  for (const server of servers) {
    if (serverTargets.has(server.target)) {
      throw new Error(`Duplicate MCP server target: ${server.target}`)
    }
    serverTargets.add(server.target)

    for (const tool of server.tools) {
      if (toolTargets.has(tool.qualifiedName)) {
        throw new Error(`Duplicate MCP tool target: ${tool.qualifiedName}`)
      }
      toolTargets.add(tool.qualifiedName)
    }
  }

  return {
    serverTargets,
    toolTargets,
  }
}

function intersectTargets(left: readonly string[], right: readonly string[]): ReadonlySet<string> {
  const allowed = new Set(right)
  const result = new Set<string>()
  for (const item of left) {
    if (allowed.has(item)) {
      result.add(item)
    }
  }
  return result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertBoolean(label: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`)
  }
  return value
}

function assertPositiveFiniteNumber(label: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`)
  }
  return value
}
