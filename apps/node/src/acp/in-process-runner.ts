import {
  type AgentExecutorFactory,
  type AgentRuntimeOptions,
  type AgentSession,
  type LoadedAgentContext,
  type OrchestrationGraph,
  createAgentSession,
  loadAgentContextForName,
} from '@tianji/agent'
import type { DomainEvent, RunId, SessionId } from '@tianji/shared'

/**
 * Runs native agents inside the daemon process to avoid ACP subprocess overhead.
 */
export class InProcessAgentRunner {
  readonly agentId: string
  readonly #taskId: string
  readonly #baseContext: LoadedAgentContext
  readonly #runtimeOptions?: AgentRuntimeOptions
  readonly #defaultGraph: OrchestrationGraph
  readonly #executorFactory: AgentExecutorFactory
  readonly #emitEvent?: (event: DomainEvent) => void
  #session: AgentSession | null = null
  #activeGeneration = 0

  constructor(config: {
    agentId: string
    taskId: string
    emitEvent?: (event: DomainEvent) => void
    nativeAgentContext: LoadedAgentContext
    runtimeOptions?: AgentRuntimeOptions
    defaultGraph: OrchestrationGraph
    executorFactory: AgentExecutorFactory
  }) {
    this.agentId = config.agentId
    this.#taskId = config.taskId
    this.#emitEvent = config.emitEvent
    this.#baseContext = config.nativeAgentContext
    this.#runtimeOptions = config.runtimeOptions
    this.#defaultGraph = config.defaultGraph
    this.#executorFactory = config.executorFactory
  }

  async connect(): Promise<void> {
    const context = await loadAgentContextForName(this.agentId, this.#baseContext)
    this.#session = await createAgentSession(context, this.#runtimeOptions)
    this.#emitEvent?.({
      type: 'TaskSessionAttached',
      taskId: this.#taskId,
      sessionId: this.#session.sessionId,
      timestamp: Date.now(),
    })
    this.#activeGeneration += 1
  }

  /**
   * 通过 queryWithGraph 向 session 发送 prompt，产出 DomainEvent 流。
   *
   * disconnect() 触发时，session.abort() 中断 queryWithGraph，此时检测到 generation
   * 不匹配，立即产出 RunCancelled 事件后 return，让 TaskExecutor 能走 cancel 分支。
   *
   * @param prompt - 用户输入的文本
   */
  async *query(prompt: string): AsyncIterable<DomainEvent> {
    if (this.#session === null) {
      throw new Error('Not connected. Call connect() first.')
    }

    const session = this.#session
    const sessionId = session.sessionId
    const generation = this.#activeGeneration
    let completedSeen = false
    let lastRunId: string | null = null

    for await (const event of session.queryWithGraph(this.#defaultGraph, {
      initialState: { input: prompt },
      compileOptions: { agentExecutorFactory: this.#executorFactory },
    })) {
      // 跟踪最新的 runId，用于 disconnect 时构造 RunCancelled 事件
      if ('runId' in event && typeof event.runId === 'string') {
        lastRunId = event.runId
      }

      if (generation !== this.#activeGeneration || this.#session !== session) {
        // disconnect 中断了 session，需要产出 RunCancelled 让 TaskExecutor 走 cancel 分支
        if (lastRunId !== null) {
          const cancelledEvent: DomainEvent = {
            type: 'RunCancelled',
            runId: lastRunId as RunId,
            sessionId: sessionId as SessionId,
            triggerType: 'new',
            timestamp: Date.now(),
            reason: 'abort',
          }
          yield cancelledEvent
        }
        return
      }

      if (event.type === 'RunCompleted') {
        if (completedSeen) {
          continue
        }
        completedSeen = true
      }

      yield event
    }
  }

  async disconnect(): Promise<void> {
    this.#session?.abort()
    this.#session = null
    this.#activeGeneration += 1
  }
}
