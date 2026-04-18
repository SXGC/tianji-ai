import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  AgentNode,
  CallMcpDiscoverResult,
  CallMcpInput,
  CallMcpInvokeResult,
  GraphRunCapabilityUpperBound,
  McpServerSummary,
  McpToolSummary,
  ResolvedNodeCapabilities,
} from '../index.js'

describe('mcp shared contracts', () => {
  it('models node-level mcpTargets and call_mcp actions', () => {
    const agentNode = {
      id: 'agent-mcp-contract',
      type: 'agent',
      agent: {
        model: 'gpt-4.1',
        systemPrompt: 'test',
        mcpTargets: ['mcp-a', 'mcp-b'],
      },
    } satisfies AgentNode

    expectTypeOf(agentNode.agent.mcpTargets).toEqualTypeOf<readonly string[] | undefined>()
    expectTypeOf<CallMcpInput>().toMatchTypeOf<
      | {
          readonly action: 'discover'
          readonly target: string
          readonly schema?: boolean
          readonly allParameters?: boolean
        }
      | {
          readonly action: 'invoke'
          readonly target: string
          readonly arguments: Record<string, unknown>
          readonly timeoutMs?: number
        }
    >()
    expectTypeOf<CallMcpDiscoverResult>().toEqualTypeOf<{
      readonly target: string
      readonly server: string
      readonly description?: string
      readonly tools: readonly McpToolSummary[]
    }>()
    expectTypeOf<CallMcpInvokeResult>().toEqualTypeOf<{
      readonly target: string
      readonly server: string
      readonly tool: string
      readonly content: unknown
      readonly structuredContent?: unknown
      readonly isError: boolean
    }>()
  })

  it('exposes the graph-run capability upper bound and resolved node capabilities', () => {
    expectTypeOf<GraphRunCapabilityUpperBound>().toEqualTypeOf<{
      readonly skills: readonly string[]
      readonly tools: readonly string[]
      readonly mcpTargets: readonly string[]
    }>()
    expectTypeOf<ResolvedNodeCapabilities>().toEqualTypeOf<{
      readonly skills: readonly string[]
      readonly tools: readonly string[]
      readonly mcpTargets: readonly string[]
    }>()
    expectTypeOf<McpServerSummary>().toHaveProperty('target')
    expectTypeOf<McpServerSummary>().toHaveProperty('name')
    expectTypeOf<McpToolSummary>().toHaveProperty('qualifiedName')
    expectTypeOf<McpToolSummary>().toHaveProperty('requiredParameters')
  })
})
