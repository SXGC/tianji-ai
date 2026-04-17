/**
 * ACP Agent bridge for tianji native agent.
 *
 * 将 ACP 协议调用桥接到 AgentSession，使原生 agent 可作为 ACP agent 运行。
 *
 * @module acp/agent-bridge
 */

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type {
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
} from '@agentclientprotocol/sdk'
import type { ObserverLogger } from '@tianji/observer'

import type { DomainEvent, DomainEventEnvelope } from '@tianji/shared'

import type { UnifiedRuntimeEntry } from '../unified-entry.js'
import { mapRuntimeEventToSessionUpdate } from './event-mapper.js'

export interface TianjiAcpAgentOptions {
  readonly logger?: ObserverLogger
}

/**
 * ACP 协议到 AgentSession 的桥接实现。
 */
export class TianjiAcpAgent {
  readonly #connection: AgentSideConnection
  readonly #entry: UnifiedRuntimeEntry
  readonly #logger: ObserverLogger | undefined
  #currentSessionId: string | null = null
  #abortController: AbortController | null = null

  constructor(
    connection: AgentSideConnection,
    entry: UnifiedRuntimeEntry,
    options: TianjiAcpAgentOptions = {}
  ) {
    this.#connection = connection
    this.#entry = entry
    this.#logger = options.logger
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    void this.#logger?.debug(['acp', 'bridge'], 'received initialize request')
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    }
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.#currentSessionId = `session_${Date.now()}`

    void this.#logger?.info(['acp', 'bridge'], 'new session created', {
      sessionId: this.#currentSessionId,
    })

    return {
      sessionId: this.#currentSessionId,
    }
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {}
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    void this.#logger?.debug(['acp', 'bridge'], 'received prompt request', {
      sessionId: params.sessionId,
    })

    if (!this.#currentSessionId) {
      throw new Error('No active session. Call newSession first.')
    }

    if (params.sessionId !== this.#currentSessionId) {
      throw new Error(`Session not found: ${params.sessionId}`)
    }

    const promptText = params.prompt
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    if (!promptText) {
      return { stopReason: 'end_turn' }
    }

    this.#abortController = new AbortController()

    try {
      const handle = await this.#entry.run({
        source: 'acp',
        input: promptText,
        sessionId: params.sessionId as never,
      })
      for await (const event of handle.events) {
        if (this.#abortController.signal.aborted) {
          void this.#logger?.debug(['acp', 'bridge'], 'prompt cancelled', {
            sessionId: params.sessionId,
          })
          return { stopReason: 'cancelled' }
        }

        const envelope = wrapAgentDomainEvent(event)
        const update = mapRuntimeEventToSessionUpdate(params.sessionId, envelope)
        if (update) {
          await this.#connection.sessionUpdate(update)
        }
      }

      void this.#logger?.debug(['acp', 'bridge'], 'prompt completed', {
        sessionId: params.sessionId,
      })
      return { stopReason: 'end_turn' }
    } finally {
      this.#abortController = null
    }
  }

  async cancel(_params: CancelNotification): Promise<void> {
    void this.#logger?.debug(['acp', 'bridge'], 'received cancel request')
    this.#abortController?.abort()
  }
}

/**
 * 将 DomainEvent 包装为最小化 DomainEventEnvelope，供 ACP 映射层消费。
 * source.processKind 固定为 'node'，表示原生 agent 进程侧。
 */
function wrapAgentDomainEvent(event: DomainEvent): DomainEventEnvelope {
  return {
    eventId: `acp_${event.type}_${Date.now()}`,
    type: event.type,
    occurredAt: new Date().toISOString(),
    correlationId: 'runId' in event ? String(event.runId) : '',
    causationId: null,
    sequence: 0,
    aggregateType: 'Run',
    aggregateId: 'runId' in event ? String(event.runId) : '',
    source: { processKind: 'node', processId: String(process.pid) },
    payload: event,
  }
}
