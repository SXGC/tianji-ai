import { resolveAgentModel } from '@tianji/runtime'
import type { LoadedAgentContext } from './context.js'
import {
  type AgentExecutorFactory,
  type CreateDeepagentsExecutorFactoryOptions,
  type OrchestrationGraph,
  createDeepagentsExecutorFactory,
  loadDefaultOrchestrationGraph,
} from './orchestration/index.js'
import type { UnifiedRunRequest } from './unified-entry.js'

export interface DefaultGraphBuildResult {
  readonly graph: OrchestrationGraph
  readonly executorFactory: AgentExecutorFactory
}

export interface BuildDefaultGraphOptions {
  /**
   * 预留 deepagents executor 的扩展装配入口。
   *
   * `resolveModel` 由默认装配统一注入，调用方不能覆盖。
   */
  readonly executorFactoryOptions?: Omit<CreateDeepagentsExecutorFactoryOptions, 'resolveModel'>
}

/**
 * 统一入口默认装配：先解析图，再构造默认执行器。
 */
export async function buildDefaultGraph(
  request: UnifiedRunRequest,
  context: LoadedAgentContext,
  options: BuildDefaultGraphOptions = {}
): Promise<DefaultGraphBuildResult> {
  const executorFactoryOptions = {
    ...options.executorFactoryOptions,
    resolveModel: (modelRef: string) => resolveAgentModel(modelRef, context.config.providers),
  } satisfies CreateDeepagentsExecutorFactoryOptions

  if (request.graph !== undefined) {
    return {
      graph: request.graph,
      executorFactory: createDeepagentsExecutorFactory(executorFactoryOptions),
    }
  }

  const graph = await loadDefaultOrchestrationGraph({
    configDir: context.paths.configDir,
    agentConfigs: context.config.agents?.items ?? {},
  })

  return {
    graph,
    executorFactory: createDeepagentsExecutorFactory(executorFactoryOptions),
  }
}
