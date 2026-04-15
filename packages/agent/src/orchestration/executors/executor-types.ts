import type { LangGraphRunnableConfig } from '@langchain/langgraph'
import type { ObserverLogger } from '@tianji/observer'
import type { DomainEvent, GraphRunDomainEvent, RunId } from '@tianji/shared'
import type { AcpAgentNode, AgentNode } from '../graph-schema.js'

/**
 * LangGraph 节点的执行函数。读 state，返回 state 的局部更新。
 */
export type NodeAction = (
  state: Record<string, unknown>,
  config: LangGraphRunnableConfig
) => Promise<Record<string, unknown>>

export interface NodeExecutorContext {
  readonly runId: RunId
  readonly graphId: string
  readonly observer?: ObserverLogger
  readonly emitGraphEvent: (event: GraphRunDomainEvent) => void
  readonly emitRuntimeEvent?: (event: DomainEvent) => void
  readonly abortSignal?: AbortSignal
}

/**
 * 把一个 AgentNode 编译为可执行的 NodeAction。
 * packages/agent 提供默认的 deepagents 实现。
 */
export type AgentExecutorFactory = (node: AgentNode, ctx: NodeExecutorContext) => NodeAction

/**
 * 把一个 AcpAgentNode 编译为可执行的 NodeAction。
 * packages/agent 不提供具体实现，由 apps/node (或其他下游) 注入。
 */
export type AcpExecutorFactory = (node: AcpAgentNode, ctx: NodeExecutorContext) => NodeAction
