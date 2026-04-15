import { LocalShellBackend } from 'deepagents'

import {
  type ObserverLogger,
  type SessionRuntime,
  ToolRegistry,
  createSessionRuntime,
} from '@tianji/runtime'
import type { DomainEvent, RunId, SessionId } from '@tianji/shared'

import { type LoadedAgentContext, injectProviderEnv } from './context.js'
import {
  type CompileOptions,
  type OrchestrationGraph,
  runOrchestrationGraph,
} from './orchestration/index.js'
import { createFetchUrlTool } from './tools/fetch-url-tool.js'

export interface AgentRuntimeOptions {
  readonly logger?: ObserverLogger
}

/**
 * 通过 OrchestrationGraph 启动一轮多智能体编排所需的参数。
 *
 * compileOptions 中的 `runId`、`observer`、`emitGraphEvent`、`abortSignal`
 * 由 session 内部负责注入：
 * - runId / observer / emitGraphEvent 由 graph-runner 透传
 * - abortSignal 由 session 通过内部维护的 AbortController 注入，供 session.abort() 终止
 *   正在运行的图；调用方若自己再传一份就会被静默覆盖，因此从公开类型中剔除
 */
export interface ChatWithGraphOptions {
  readonly initialState?: Record<string, unknown>
  readonly compileOptions: Omit<
    CompileOptions,
    'runId' | 'observer' | 'emitGraphEvent' | 'abortSignal'
  >
}

export interface AgentSession {
  readonly sessionId: SessionId
  readonly queryWithGraph: (
    graph: OrchestrationGraph,
    options: ChatWithGraphOptions
  ) => AsyncIterable<DomainEvent>
  readonly abort: () => void
}

/**
 * Creates a runtime instance from an already loaded agent context.
 *
 * The runtime uses {@link LocalShellBackend} to give the agent real filesystem
 * and shell access in the configured workspace directory.
 *
 * @param context - The resolved agent bootstrap context
 * @returns A session runtime configured for the selected provider and model
 */
export async function createAgentRuntime(
  context: LoadedAgentContext,
  options?: AgentRuntimeOptions
): Promise<SessionRuntime> {
  injectProviderEnv(context)

  const backend = await LocalShellBackend.create({
    rootDir: context.agent.workspace ?? process.cwd(),
    inheritEnv: true,
  })

  // 通过 ToolCatalog 注册 fetch_url,自动获得 runtime 的策略门、超时控制、HITL pending 与 tool.* 事件流。
  const toolCatalog = new ToolRegistry().registerTool(createFetchUrlTool())

  return createSessionRuntime({
    deepagents: {
      model: `${context.agent.provider}:${context.agent.modelName}`,
      providerConfig: {
        provider: context.agent.provider,
        model: context.agent.modelName,
        apiKey: context.agent.providerConfig?.apiKey,
        baseUrl: readProviderBaseUrl(context),
        headers: readProviderHeaders(context),
      },
      backend,
    },
    snapshotStore: context.snapshotStore,
    toolCatalog,
    logger: options?.logger,
  })
}

/**
 * Creates a session-scoped chat facade for CLI and future app entrypoints.
 *
 * @param context - The resolved agent bootstrap context
 * @returns A session wrapper that emits runtime events for each prompt
 */
export async function createAgentSession(
  context: LoadedAgentContext,
  options?: AgentRuntimeOptions
): Promise<AgentSession> {
  const runtime = await createAgentRuntime(context, options)
  const sessionId = `session_${Date.now()}` as SessionId
  // 当前 session 内所有仍在运行的 queryWithGraph 对应的 AbortController。
  // session.abort() 会同时通知这些图级控制器，让节点执行器（deepagents-executor / acp-executor）
  // 走 AbortSignal 路径中断正在进行的 runtime 调用。
  const activeGraphControllers = new Set<AbortController>()

  // runtime.createSession 是初始化语义,会无脑覆盖 sessions/{sessionId}.json 的 messages 为空。
  // 必须只在 AgentSession 工厂里调用一次,否则后续每轮 query 都会清掉前一轮 runTurn 累加的多轮历史。
  await runtime.createSession({ sessionId })

  return {
    sessionId,
    abort(): void {
      // 通知所有进行中的图运行终止；controller 会在各自 queryWithGraph 的 finally
      // 里从集合里移除，这里只负责发信号。
      for (const controller of activeGraphControllers) {
        controller.abort()
      }
    },
    async *queryWithGraph(
      graph: OrchestrationGraph,
      graphOptions: ChatWithGraphOptions
    ): AsyncIterable<DomainEvent> {
      // runId 是 @tianji/shared 的分支类型，这里用 session 级时间戳生成唯一值即可。
      const runId = `run_graph_${Date.now()}` as RunId
      const controller = new AbortController()
      activeGraphControllers.add(controller)

      try {
        const result = runOrchestrationGraph({
          graph,
          runId,
          initialState: graphOptions.initialState,
          compileOptions: graphOptions.compileOptions,
          observer: options?.logger,
          abortSignal: controller.signal,
          onMermaid: (diagram) => {
            void options?.logger?.info(['agent', 'orchestration'], 'graph.mermaid', {
              sessionId,
              runId,
              graphId: graph.id,
              graphVersion: graph.version,
              diagram,
            })
          },
        })

        // DomainEvent 是图级与运行时事件的统一类型，直接产出给上层消费者。
        for await (const event of result.events) {
          yield event
        }
        await result.finished
      } finally {
        // 无论正常结束、消费者 break、还是底层抛错，都要从集合中移除 controller，
        // 避免悬挂的 controller 影响后续 abort() 语义。
        activeGraphControllers.delete(controller)
      }
    },
  }
}

function readProviderBaseUrl(context: LoadedAgentContext): string | undefined {
  return typeof context.agent.providerConfig?.baseUrl === 'string'
    ? context.agent.providerConfig.baseUrl
    : undefined
}

function readProviderHeaders(context: LoadedAgentContext): Record<string, string> | undefined {
  if (
    context.agent.providerConfig?.headers === undefined ||
    context.agent.providerConfig.headers === null ||
    typeof context.agent.providerConfig.headers !== 'object'
  ) {
    return undefined
  }

  const headerEntries = Object.entries(context.agent.providerConfig.headers).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )

  return headerEntries.length > 0 ? Object.fromEntries(headerEntries) : undefined
}
