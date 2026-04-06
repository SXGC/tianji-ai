/**
 * Agent Runner: spawn + ACP connect + event stream.
 *
 * @module acp/agent-runner
 */

import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { type RuntimeEvent, createRunId, createSessionId } from '@tianji/shared'

import { AgentProcessManager, resolveAgentEntryPath } from './agent-process.js'
import { AcpNodeClient } from './client-bridge.js'
import { mapSessionUpdateToRuntimeEvent } from './event-adapter.js'

export interface AgentRunnerConfig {
  readonly agentId: string
  /** agent 入口 JS 文件路径，默认解析 @tianji/agent 的 acp-entry.js */
  readonly entryPath?: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
}

export class AgentRunner {
  readonly agentId: string
  readonly #config: AgentRunnerConfig
  #processManager: AgentProcessManager | null = null
  #connection: ClientSideConnection | null = null
  #client: AcpNodeClient | null = null
  #acpSessionId: string | null = null

  constructor(config: AgentRunnerConfig) {
    this.agentId = config.agentId
    this.#config = config
  }

  async connect(): Promise<void> {
    this.#processManager = new AgentProcessManager({
      agentId: this.#config.agentId,
      entryPath: this.#config.entryPath ?? resolveAgentEntryPath(),
      args: [...(this.#config.args ?? [])],
      env: this.#config.env,
    })

    const streams = this.#processManager.spawn()
    const stream = ndJsonStream(streams.output, streams.input)

    this.#client = new AcpNodeClient()
    this.#connection = new ClientSideConnection((_agent) => this.#client as AcpNodeClient, stream)

    await this.#connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    })

    const sessionResponse = await this.#connection.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    })
    this.#acpSessionId = sessionResponse.sessionId
  }

  async *chat(prompt: string): AsyncIterable<RuntimeEvent> {
    if (this.#connection === null || this.#client === null || this.#acpSessionId === null) {
      throw new Error('Not connected. Call connect() first.')
    }

    const runId = createRunId(`run_${Date.now()}`)
    const sessionId = createSessionId(this.#acpSessionId)
    const eventBuffer: RuntimeEvent[] = []

    const unsubscribe = this.#client.onSessionUpdate((update) => {
      const event = mapSessionUpdateToRuntimeEvent(update, runId)
      if (event !== null) {
        eventBuffer.push(event)
      }
    })

    try {
      const promptResult = this.#connection.prompt({
        sessionId: this.#acpSessionId,
        prompt: [{ type: 'text', text: prompt }],
      })

      let promptDone = false
      void promptResult.then(
        () => {
          promptDone = true
        },
        () => {
          promptDone = true
        }
      )

      while (!promptDone || eventBuffer.length > 0) {
        if (eventBuffer.length > 0) {
          const event = eventBuffer.shift()
          if (event) {
            yield event
          }
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }

      yield {
        type: 'run.completed',
        runId,
        sessionId,
        triggerType: 'new',
        timestamp: Date.now(),
      }
    } finally {
      unsubscribe()
    }
  }

  async disconnect(): Promise<void> {
    await this.#processManager?.kill()
    this.#processManager = null
    this.#connection = null
    this.#client = null
    this.#acpSessionId = null
  }
}
