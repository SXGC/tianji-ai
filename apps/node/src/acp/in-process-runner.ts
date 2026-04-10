import {
  type AgentExecutorFactory,
  type AgentRuntimeOptions,
  type AgentSession,
  type LoadedAgentContext,
  type OrchestrationGraph,
  createAgentSession,
  loadAgentContextForName,
} from '@tianji/agent'
import type { RuntimeEvent } from '@tianji/shared'

/**
 * Runs native agents inside the daemon process to avoid ACP subprocess overhead.
 */
export class InProcessAgentRunner {
  readonly agentId: string
  readonly #baseContext: LoadedAgentContext
  readonly #runtimeOptions?: AgentRuntimeOptions
  readonly #defaultGraph: OrchestrationGraph
  readonly #executorFactory: AgentExecutorFactory
  #session: AgentSession | null = null
  #activeGeneration = 0

  constructor(config: {
    agentId: string
    nativeAgentContext: LoadedAgentContext
    runtimeOptions?: AgentRuntimeOptions
    defaultGraph: OrchestrationGraph
    executorFactory: AgentExecutorFactory
  }) {
    this.agentId = config.agentId
    this.#baseContext = config.nativeAgentContext
    this.#runtimeOptions = config.runtimeOptions
    this.#defaultGraph = config.defaultGraph
    this.#executorFactory = config.executorFactory
  }

  async connect(): Promise<void> {
    const context = await loadAgentContextForName(this.agentId, this.#baseContext)
    this.#session = await createAgentSession(context, this.#runtimeOptions)
    this.#activeGeneration += 1
  }

  /**
   * 通过 queryWithGraph 向 session 发送 prompt，产出 RuntimeEvent 流。
   *
   * @param prompt - 用户输入的文本
   */
  async *query(prompt: string): AsyncIterable<RuntimeEvent> {
    if (this.#session === null) {
      throw new Error('Not connected. Call connect() first.')
    }

    const session = this.#session
    const generation = this.#activeGeneration
    let completedSeen = false

    for await (const event of session.queryWithGraph(this.#defaultGraph, {
      initialState: { input: prompt },
      compileOptions: { agentExecutorFactory: this.#executorFactory },
    })) {
      if (generation !== this.#activeGeneration || this.#session !== session) {
        return
      }

      if (event.type === 'run.completed') {
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
