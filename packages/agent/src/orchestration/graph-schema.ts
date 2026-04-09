/**
 * 编排图的 JSON Schema 类型定义。
 * 这些类型对应可序列化的图结构，由 graph-compiler 编译为 LangGraph CompiledStateGraph。
 */

export type OrchestrationGraphSource = 'static' | 'llm' | 'human'

export interface OrchestrationGraph {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly source: OrchestrationGraphSource
  readonly locked: boolean
  readonly state: Record<string, StateChannelDef>
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
}

export type StateChannelType = 'string' | 'number' | 'boolean' | 'list' | 'object'
export type StateChannelReducer = 'append' | 'replace' | 'merge'

export interface StateChannelDef {
  readonly type: StateChannelType
  readonly default?: unknown
  readonly reducer?: StateChannelReducer
}

export type GraphNode = AgentNode | AcpAgentNode | RouterNode | HumanGateNode | ForkNode

export interface SubAgentDef {
  readonly name: string
  readonly description?: string
  readonly systemPrompt?: string
  readonly tools?: readonly string[]
  readonly model?: string
}

export interface AgentNode {
  readonly id: string
  readonly type: 'agent'
  readonly agent: {
    readonly model: string
    readonly systemPrompt: string
    readonly tools?: readonly string[]
    readonly subagents?: readonly SubAgentDef[]
    readonly skills?: readonly string[]
  }
  readonly input?: readonly string[]
  readonly output?: readonly string[]
}

export interface AcpAgentNode {
  readonly id: string
  readonly type: 'acp-agent'
  readonly acp: {
    readonly command?: string
    readonly args?: readonly string[]
    readonly endpoint?: string
    readonly auth?: { readonly type: 'bearer'; readonly tokenEnv: string }
    readonly timeout?: number
  }
  readonly input?: readonly string[]
  readonly output?: readonly string[]
}

export interface RouterNode {
  readonly id: string
  readonly type: 'router'
  readonly condition: {
    readonly field: string
    readonly branches: Record<string, string>
  }
}

export interface HumanGateNode {
  readonly id: string
  readonly type: 'human-gate'
  readonly prompt: string
}

export interface ForkNode {
  readonly id: string
  readonly type: 'fork'
  readonly targets: readonly string[]
  readonly join: string
}

export interface GraphEdge {
  readonly from: string
  readonly to: string
}

/** LangGraph 保留节点名 */
export const GRAPH_START = '__start__' as const
export const GRAPH_END = '__end__' as const

export type ReservedNodeId = typeof GRAPH_START | typeof GRAPH_END
