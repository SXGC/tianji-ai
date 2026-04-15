/**
 * SessionRuntime barrel re-export。
 *
 * 业务职责：
 * - 为 __tests__/ 深路径 import（../runtime.js）提供兼容入口。
 * - 将 runtime/ 子模块符号统一转发到外部可见层。
 *
 * 对外触点：
 * - 被 packages/runtime/src/index.ts 的具名导出引用。
 * - 被 __tests__/ 下各测试文件通过 `../runtime.js` 深路径 import。
 */
export type { RuntimeProviderConfig, SessionRuntimeDeepagentsConfig } from './types.js'
export type { ObserverLogger } from '@tianji/observer'
export type {
  AbortSignalScope,
  ActiveRun,
  CreateSessionOptions,
  DeepagentsInterruptRecord,
  DeepagentsRunWorkflowState,
  ExecuteRunInput,
  ResumeRunOptions,
  RunExecutionContext,
  RunLineageFields,
  RunRuntimeMetadata,
  RunTurnOptions,
  SessionRuntime,
  SessionRuntimeEngine,
  SessionRuntimeMetadata,
  SessionRuntimeOptions,
} from './runtime/types.js'
export {
  readDeepagentsRunWorkflowState,
  readRunRuntimeMetadata,
  readSessionRuntimeMetadata,
} from './runtime/metadata.js'
export { createSessionRuntime } from './runtime/session-runtime.js'
