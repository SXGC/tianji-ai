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
  /** 可选：注入 DomainEvent 发射回调，用于发射 Session 生命周期事件。 */
  readonly emitEvent?: (ev: DomainEvent) => void | Promise<void>
}

/**
 * 会话恢复参数。
 *
 * @param checkpointId - 要从哪个检查点恢复的 ID（由 runtime 层保存）
 * @param sessionId - 原始 session 的 ID，用于关联已有 session 快照
 */
export interface ResumeAgentSessionOptions {
  readonly checkpointId: string
  readonly sessionId: SessionId
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
  /** 关闭 session，发射 SessionClosed 事件，中止所有进行中的图运行。 */
  readonly close: () => void
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

  await options?.emitEvent?.({
    type: 'SessionCreated',
    sessionId,
    timestamp: Date.now(),
  })

  return {
    sessionId,
    abort(): void {
      // 通知所有进行中的图运行终止；controller 会在各自 queryWithGraph 的 finally
      // 里从集合里移除，这里只负责发信号。
      for (const controller of activeGraphControllers) {
        controller.abort()
      }
    },
    close(): void {
      for (const controller of activeGraphControllers) {
        controller.abort()
      }
      // close() 是同步方法，无法 await。用 .catch 显式捕获，防止 fire-and-forget 丢失错误。
      const result = options?.emitEvent?.({
        type: 'SessionClosed',
        sessionId,
        timestamp: Date.now(),
      })
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          void options?.logger?.error(['agent', 'session'], 'SessionClosed emitEvent failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
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

/**
 * 会话恢复入口：从指定检查点重建 runtime session，并通过 pipeline 发射 SessionResumed 事件。
 *
 * 按照 spec §三，SessionResumed 必须由 agent 层发射，checkpointId 随 payload 携带。
 * 当前无调用者，但入口必须建立以便 Stage 07+ 集成。
 *
 * @param context - 已加载的 agent bootstrap 上下文
 * @param resumeOptions - 恢复参数（checkpointId + sessionId）
 * @param runtimeOptions - 运行时选项（logger、emitEvent）
 * @returns 复用同一 sessionId 的 AgentSession 实例
 */
export async function resumeAgentSession(
  context: LoadedAgentContext,
  resumeOptions: ResumeAgentSessionOptions,
  runtimeOptions?: AgentRuntimeOptions
): Promise<AgentSession> {
  const { checkpointId, sessionId } = resumeOptions
  const runtime = await createAgentRuntime(context, runtimeOptions)
  const activeGraphControllers = new Set<AbortController>()

  // 恢复语义：runtime.createSession 使用已有 sessionId，runtime 内部会加载已有快照。
  // 与 createAgentSession 的"初始化语义"不同，这里只是让 runtime 找到该 session。
  await runtime.createSession({ sessionId })

  await runtimeOptions?.emitEvent?.({
    type: 'SessionResumed',
    sessionId,
    checkpointId,
    timestamp: Date.now(),
  })

  return {
    sessionId,
    abort(): void {
      for (const controller of activeGraphControllers) {
        controller.abort()
      }
    },
    close(): void {
      for (const controller of activeGraphControllers) {
        controller.abort()
      }
      // close() 是同步方法，无法 await。用 .catch 显式捕获，防止 fire-and-forget 丢失错误。
      const result = runtimeOptions?.emitEvent?.({
        type: 'SessionClosed',
        sessionId,
        timestamp: Date.now(),
      })
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          void runtimeOptions?.logger?.error(
            ['agent', 'session'],
            'SessionClosed emitEvent failed',
            { sessionId, error: err instanceof Error ? err.message : String(err) }
          )
        })
      }
    },
    async *queryWithGraph(
      graph: OrchestrationGraph,
      graphOptions: ChatWithGraphOptions
    ): AsyncIterable<DomainEvent> {
      const runId = `run_graph_${Date.now()}` as RunId
      const controller = new AbortController()
      activeGraphControllers.add(controller)

      try {
        const result = runOrchestrationGraph({
          graph,
          runId,
          initialState: graphOptions.initialState,
          compileOptions: graphOptions.compileOptions,
          observer: runtimeOptions?.logger,
          abortSignal: controller.signal,
          onMermaid: (diagram) => {
            void runtimeOptions?.logger?.info(['agent', 'orchestration'], 'graph.mermaid', {
              sessionId,
              runId,
              graphId: graph.id,
              graphVersion: graph.version,
              diagram,
            })
          },
        })

        for await (const event of result.events) {
          yield event
        }
        await result.finished
      } finally {
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
