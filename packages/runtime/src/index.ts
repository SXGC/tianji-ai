/**
 * runtime 包公共导出入口。
 *
 * 业务职责：
 * - 统一暴露运行时、快照存储、事件流与工具目录能力。
 * - 约束消费方只通过稳定入口访问 runtime API，避免深层路径耦合。
 *
 * 对外触点：
 * - 被 packages/runtime 的外部消费者直接 import。
 * - 与 ./runtime.ts、./snapshot-store.ts、./event-stream.ts、./tool-catalog.ts 的导出边界保持一致。
 */
export { ReplayableEventStream } from './event-stream.js'
export { FileSnapshotStore, InMemorySnapshotStore, type SnapshotStore } from './snapshot-store.js'
export {
  ToolRegistry,
  ensureToolAllowed,
  type RuntimeToolDefinition,
  type RuntimeToolExecutionContext,
  type RuntimeToolSideEffect,
  type ToolCatalog,
} from './tool-catalog.js'
export {
  createSessionRuntime,
  type CreateSessionOptions,
  type DeepagentsInterruptRecord,
  type DeepagentsRunWorkflowState,
  type RunRuntimeMetadata,
  type ResumeRunOptions,
  type RunTurnOptions,
  type SessionRuntimeDeepagentsConfig,
  type SessionRuntimeEngine,
  type SessionRuntimeMetadata,
  type SessionRuntime,
  type SessionRuntimeOptions,
  readDeepagentsRunWorkflowState,
  readRunRuntimeMetadata,
  readSessionRuntimeMetadata,
} from './runtime.js'
