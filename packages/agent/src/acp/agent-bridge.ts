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

import type { AgentSession } from '../session.js'
import { mapRuntimeEventToSessionUpdate } from './event-mapper.js'

type SessionFactory = () => AgentSession

/**
 * ACP 协议到 AgentSession 的桥接实现。
 */
export class TianjiAcpAgent {
  readonly #connection: AgentSideConnection
  readonly #sessionFactory: SessionFactory
  #currentSession: AgentSession | null = null
  #abortController: AbortController | null = null

  constructor(connection: AgentSideConnection, sessionFactory: SessionFactory) {
    this.#connection = connection
    this.#sessionFactory = sessionFactory
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
    this.#currentSession = this.#sessionFactory()

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
      for await (const event of this.#currentSession.query(promptText)) {
        if (this.#abortController.signal.aborted) {
          console.error('[acp-agent] Prompt cancelled')
          return { stopReason: 'cancelled' }
        }

        const update = mapRuntimeEventToSessionUpdate(params.sessionId, event)
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
