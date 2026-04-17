/**
 * Agent Runner: spawn + ACP connect + event stream.
 *
 * @module acp/agent-runner
 */

import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import {
  DEFAULT_AGENT_COMMAND,
  type DomainEvent,
  type RunId,
  createRunId,
  createSessionId,
} from '@tianji/shared'

import type { RuntimeLogger } from '../logger.js'
import { AgentProcessManager } from './agent-process.js'
import { AcpNodeClient } from './client-bridge.js'
import { mapSessionUpdateToRuntimeEvent } from './event-adapter.js'

export interface AgentRunnerConfig {
  readonly agentId: string
  /** 可执行命令，默认 tianji-agent */
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
  readonly logger?: RuntimeLogger
}

export class AgentRunner {
  readonly agentId: string
  readonly #config: AgentRunnerConfig
  #processManager: AgentProcessManager | null = null
  #connection: ClientSideConnection | null = null
  #client: AcpNodeClient | null = null
  #acpSessionId: string | null = null
  #disconnectController: AbortController | null = null

  constructor(config: AgentRunnerConfig) {
    this.agentId = config.agentId
    this.#config = config
  }

  async connect(): Promise<void> {
    await this.#config.logger?.logInfo(['acp', 'runner'], 'Connecting to agent', {
      agentId: this.#config.agentId,
      command: this.#config.command ?? DEFAULT_AGENT_COMMAND,
    })

    this.#processManager = new AgentProcessManager({
      agentId: this.#config.agentId,
      command: this.#config.command ?? DEFAULT_AGENT_COMMAND,
      args: [...(this.#config.args ?? [])],
      env: this.#config.env,
      logger: this.#config.logger,
    })

    const streams = this.#processManager.spawn()
    const stream = ndJsonStream(streams.output, streams.input)

    this.#client = new AcpNodeClient()
    this.#connection = new ClientSideConnection((_agent) => this.#client as AcpNodeClient, stream)

    await this.#connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    })

    await this.#config.logger?.logDebug(['acp', 'runner'], 'ACP connection initialized', {
      agentId: this.#config.agentId,
    })

    const sessionResponse = await this.#connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    })
    this.#acpSessionId = sessionResponse.sessionId

    await this.#config.logger?.logInfo(['acp', 'runner'], 'ACP session created', {
      agentId: this.#config.agentId,
      acpSessionId: this.#acpSessionId,
    })

    this.#disconnectController = new AbortController()
  }

  async *query(prompt: string): AsyncIterable<DomainEvent> {
    if (this.#connection === null || this.#client === null || this.#acpSessionId === null) {
      throw new Error('Not connected. Call connect() first.')
    }

    await this.#config.logger?.logInfo(['acp', 'runner'], 'Agent chat started', {
      agentId: this.#config.agentId,
      promptLength: prompt.length,
    })

    const runId = createRunId(`run_${Date.now()}`)
    const sessionId = createSessionId(this.#acpSessionId)
    const eventBuffer: DomainEvent[] = []

    const unsubscribe = this.#client.onSessionUpdate((update) => {
      const envelope = mapSessionUpdateToRuntimeEvent(update, runId)
      if (envelope !== null) {
        eventBuffer.push(envelope)
      }
    })

    const signal = this.#disconnectController?.signal

    // 构造一个 abort 信号对应的 Promise，当 disconnect() 触发时立即 resolve
    // 用于打断 while 循环中的 sleep，让 cancel 路径快速退出
    const abortPromise: Promise<'aborted'> | null =
      signal === undefined
        ? null
        : new Promise<'aborted'>((resolve) => {
            if (signal.aborted) {
              resolve('aborted')
              return
            }
            signal.addEventListener('abort', () => resolve('aborted'), { once: true })
          })

    try {
      const promptResult = this.#connection.prompt({
        sessionId: this.#acpSessionId,
        prompt: [{ type: 'text', text: prompt }],
      })

      let promptDone = false
      let promptError: unknown = null
      void promptResult.then(
        () => {
          promptDone = true
        },
        (error: unknown) => {
          promptDone = true
          promptError = error
        }
      )

      while (!signal?.aborted && (!promptDone || eventBuffer.length > 0)) {
        if (eventBuffer.length > 0) {
          const event = eventBuffer.shift()
          if (event) {
            yield event
          }
        } else {
          // 等待新事件、prompt 完成或 abort 信号，三者任意一个触发即唤醒
          await Promise.race([
            new Promise<void>((resolve) => setTimeout(resolve, 10)),
            abortPromise ?? new Promise<never>(() => {}),
          ])
        }
      }

      if (signal?.aborted) {
        await this.#config.logger?.logInfo(
          ['acp', 'runner'],
          'Agent chat cancelled via disconnect',
          {
            agentId: this.#config.agentId,
          }
        )
        const cancelledEvent: DomainEvent = {
          type: 'RunCancelled',
          runId,
          sessionId,
          triggerType: 'new',
          timestamp: Date.now(),
          reason: 'abort',
        }
        yield cancelledEvent
        return
      }

      if (promptError !== null) {
        const errorMessage =
          promptError instanceof Error ? promptError.message : String(promptError)
        const stack = promptError instanceof Error ? promptError.stack : undefined
        await this.#config.logger?.logError(['acp', 'runner'], 'Agent prompt failed', {
          agentId: this.#config.agentId,
          errorMessage,
          stack,
        })
        throw promptError
      }

      await this.#config.logger?.logInfo(['acp', 'runner'], 'Agent chat completed', {
        agentId: this.#config.agentId,
      })

      const completedEvent: DomainEvent = {
        type: 'RunCompleted',
        runId,
        sessionId,
        triggerType: 'new',
        timestamp: Date.now(),
      }
      yield completedEvent
    } finally {
      unsubscribe()
    }
  }

  async disconnect(): Promise<void> {
    await this.#config.logger?.logDebug(['acp', 'runner'], 'Disconnecting agent', {
      agentId: this.#config.agentId,
    })
    this.#disconnectController?.abort()
    await this.#processManager?.kill()
    this.#processManager = null
    this.#connection = null
    this.#client = null
    this.#acpSessionId = null
    this.#disconnectController = null
  }
}
