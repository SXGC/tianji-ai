import type { LangGraphRunnableConfig } from '@langchain/langgraph'
import type { ObserverLogger } from '@tianji/observer'
import type { RuntimeTracingContext, SnapshotStore } from '@tianji/runtime'
import type {
  DomainEvent,
  GraphRunCapabilityUpperBound,
  GraphRunDomainEvent,
  ResolvedNodeCapabilities,
  RunId,
  SessionId,
} from '@tianji/shared'
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
  /** 跨轮持久化的会话 ID，由上层 session facade 注入。未设置时节点执行器创建临时会话。 */
  readonly sessionId?: SessionId
  /** 与 sessionId 配套的持久化存储，注入后节点执行器使用它替换默认的 InMemorySnapshotStore。 */
  readonly snapshotStore?: SnapshotStore
  /** graph-run 级能力上限。允许每次 run 单独注入，不把上界固定死在工厂实例上。 */
  readonly graphRunCapabilityUpperBound?: GraphRunCapabilityUpperBound
  /** graph-run 级节点能力解析入口。未提供时由执行器使用默认 resolver。 */
  readonly resolveNodeCapabilities?: (
    node: AgentNode,
    upperBound: GraphRunCapabilityUpperBound
  ) => ResolvedNodeCapabilities
  readonly graphTracingContext?: RuntimeTracingContext
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
