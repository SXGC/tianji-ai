import { resolveAgentModel } from '@tianji/runtime'
import type { LoadedAgentContext } from './context.js'
import {
  type AgentExecutorFactory,
  type OrchestrationGraph,
  createDeepagentsExecutorFactory,
  loadDefaultOrchestrationGraph,
} from './orchestration/index.js'
import type { UnifiedRunRequest } from './unified-entry.js'

export interface DefaultGraphBuildResult {
  readonly graph: OrchestrationGraph
  readonly executorFactory: AgentExecutorFactory
}

/**
 * 统一入口默认装配：先解析图，再构造默认执行器。
 */
export async function buildDefaultGraph(
  request: UnifiedRunRequest,
  context: LoadedAgentContext
): Promise<DefaultGraphBuildResult> {
  if (request.graph !== undefined) {
    return {
      graph: request.graph,
      executorFactory: createDeepagentsExecutorFactory({
        resolveModel: (modelRef) => resolveAgentModel(modelRef, context.config.providers),
      }),
    }
  }

  const graph = await loadDefaultOrchestrationGraph({
    configDir: context.paths.configDir,
    agentConfigs: context.config.agents?.items ?? {},
  })

  return {
    graph,
    executorFactory: createDeepagentsExecutorFactory({
      resolveModel: (modelRef) => resolveAgentModel(modelRef, context.config.providers),
    }),
  }
}
