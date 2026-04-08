import {
  type AgentSession,
  type LoadedAgentContext,
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
  #session: AgentSession | null = null
  #activeGeneration = 0

  constructor(config: { agentId: string; nativeAgentContext: LoadedAgentContext }) {
    this.agentId = config.agentId
    this.#baseContext = config.nativeAgentContext
  }

  async connect(): Promise<void> {
    const context = await loadAgentContextForName(this.agentId, this.#baseContext)
    this.#session = await createAgentSession(context)
    this.#activeGeneration += 1
  }

  async *query(prompt: string): AsyncIterable<RuntimeEvent> {
    if (this.#session === null) {
      throw new Error('Not connected. Call connect() first.')
    }

    const session = this.#session
    const generation = this.#activeGeneration
    let completedSeen = false

    for await (const event of session.query(prompt)) {
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
