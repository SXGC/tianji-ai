/**
 * 编排图 schema 已下沉到 shared，这里只保留兼容导出，避免调用方一次性全改。
 */
export {
  GRAPH_END,
  GRAPH_START,
  type AcpAgentNode,
  type AgentNode,
  type ForkNode,
  type GraphEdge,
  type GraphNode,
  type HumanGateNode,
  type OrchestrationGraph,
  type OrchestrationGraphSource,
  type ReservedNodeId,
  type RouterNode,
  type StateChannelDef,
  type StateChannelReducer,
  type StateChannelType,
  type SubAgentDef,
} from '@tianji/shared'
