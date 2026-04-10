/**
 * 编排子包的公共导出。
 *
 * 该文件汇总编排图的编译、校验、运行以及执行器工厂，供 packages/agent 顶层
 * 以及下游消费者（apps/node、测试、未来的 CLI 入口）按需引入。
 */
export { compileOrchestrationGraph, type CompileOptions } from './graph-compiler.js'
export {
  runOrchestrationGraph,
  type OrchestrationRunResult,
  type RunOrchestrationGraphOptions,
} from './graph-runner.js'
export { validateOrchestrationGraph, type ValidationResult } from './graph-validator.js'
export { compileStateChannels } from './state-channels.js'
export {
  buildPromptFromState,
  buildStateUpdateFromText,
  buildOutputInstructionSuffix,
} from './io-mapping.js'
export {
  createDeepagentsExecutorFactory,
  type CreateDeepagentsExecutorFactoryOptions,
} from './executors/deepagents-executor.js'
export {
  createAcpExecutorFactory,
  type CreateAcpExecutorFactoryOptions,
  type AcpRunnerLike,
  type AcpRunnerProvider,
} from './executors/acp-executor.js'
export type {
  NodeAction,
  NodeExecutorContext,
  AgentExecutorFactory,
  AcpExecutorFactory,
} from './executors/executor-types.js'
export type {
  OrchestrationGraph,
  OrchestrationGraphSource,
  StateChannelDef,
  StateChannelType,
  StateChannelReducer,
  GraphNode,
  AgentNode,
  AcpAgentNode,
  RouterNode,
  HumanGateNode,
  ForkNode,
  GraphEdge,
  SubAgentDef,
  ReservedNodeId,
} from './graph-schema.js'
export { GRAPH_START, GRAPH_END } from './graph-schema.js'
export {
  loadDefaultOrchestrationGraph,
  type GraphLoaderOptions,
} from './graph-loader.js'
export {
  buildSystemPrompt,
  type BuildSystemPromptOptions,
} from './system-prompt-builder.js'
