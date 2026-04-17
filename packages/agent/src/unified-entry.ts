import type {
  UnifiedCancelRequest,
  UnifiedEntryDeps,
  UnifiedResumeRequest,
  UnifiedRunHandle,
  UnifiedRunRequest,
  UnifiedRuntimeEntry,
  UnifiedStreamRequest,
} from './unified-entry-types.js'
export type {
  UnifiedCancelRequest,
  UnifiedResumeRequest,
  UnifiedRunHandle,
  UnifiedRunRequest,
  UnifiedRuntimeEntry,
  UnifiedStreamRequest,
} from './unified-entry-types.js'

/**
 * 统一入口只负责先装配默认图与执行器，再委托 runtime 执行。
 */
export function createUnifiedRuntimeEntry(deps: UnifiedEntryDeps): UnifiedRuntimeEntry {
  return {
    async run(request: UnifiedRunRequest): Promise<UnifiedRunHandle> {
      const graph = await deps.loadDefaultGraph(request)
      const executors = await deps.createExecutorRegistry(request)
      return deps.runtime.runGraph({ request, graph, executors })
    },
    async resume(request: UnifiedResumeRequest): Promise<UnifiedRunHandle> {
      return deps.runtime.resumeGraph(request)
    },
    async cancel(request: UnifiedCancelRequest): Promise<void> {
      await deps.runtime.cancelRun(request)
    },
    stream(request: UnifiedStreamRequest) {
      return deps.runtime.streamRun(request)
    },
  }
}
