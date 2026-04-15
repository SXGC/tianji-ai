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

import type { DomainEvent, DomainEventEnvelope } from '@tianji/shared'

import type { AgentExecutorFactory, OrchestrationGraph } from '../orchestration/index.js'
import type { AgentSession } from '../session.js'
import { mapRuntimeEventToSessionUpdate } from './event-mapper.js'

type SessionFactory = () => AgentSession | Promise<AgentSession>

/**
 * ACP 协议到 AgentSession 的桥接实现。
 */
export class TianjiAcpAgent {
  readonly #connection: AgentSideConnection
  readonly #sessionFactory: SessionFactory
  readonly #defaultGraph: OrchestrationGraph
  readonly #executorFactory: AgentExecutorFactory
  #currentSession: AgentSession | null = null
  #abortController: AbortController | null = null

  constructor(
    connection: AgentSideConnection,
    sessionFactory: SessionFactory,
    defaultGraph: OrchestrationGraph,
    executorFactory: AgentExecutorFactory
  ) {
    this.#connection = connection
    this.#sessionFactory = sessionFactory
    this.#defaultGraph = defaultGraph
    this.#executorFactory = executorFactory
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    console.error('[acp-agent] Received initialize request')
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    }
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.#currentSession = await this.#sessionFactory()

    console.error('[acp-agent] New session created:', this.#currentSession.sessionId)

    return {
      sessionId: this.#currentSession.sessionId,
    }
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {}
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    console.error('[acp-agent] Received prompt request, session:', params.sessionId)

    if (!this.#currentSession) {
      throw new Error('No active session. Call newSession first.')
    }

    if (params.sessionId !== this.#currentSession.sessionId) {
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
      for await (const event of this.#currentSession.queryWithGraph(this.#defaultGraph, {
        initialState: { input: promptText },
        compileOptions: { agentExecutorFactory: this.#executorFactory },
      })) {
        if (this.#abortController.signal.aborted) {
          console.error('[acp-agent] Prompt cancelled')
          return { stopReason: 'cancelled' }
        }

        const envelope = wrapAgentDomainEvent(event)
        const update = mapRuntimeEventToSessionUpdate(params.sessionId, envelope)
        if (update) {
          await this.#connection.sessionUpdate(update)
        }
      }

      console.error('[acp-agent] Prompt completed')
      return { stopReason: 'end_turn' }
    } finally {
      this.#abortController = null
    }
  }

  async cancel(_params: CancelNotification): Promise<void> {
    console.error('[acp-agent] Received cancel request')
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
