/**
 * Control Plane connection lifecycle loop.
 *
 * @module controlplane/connection-loop
 */

import type { AgentInfo, NodeExecutionState, NodeId, PollCommandResponse } from '@tianji/shared'

import { ControlPlaneAuthError, ControlPlaneClient } from './client.js'

export interface ControlPlaneConnectionConfig {
  readonly baseUrl: string
  readonly nodeId: NodeId
  readonly enrollmentToken: string
  readonly hostname: string
  readonly platform: string
  readonly version: string
  readonly agentList: readonly AgentInfo[]
  readonly heartbeatIntervalMs?: number
  readonly onCommand: (command: PollCommandResponse) => void
}

export class ControlPlaneConnection {
  readonly #config: ControlPlaneConnectionConfig
  readonly #client: ControlPlaneClient
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null
  #pollAbortController: AbortController | null = null
  #running = false
  #executionState: NodeExecutionState = 'idle'

  constructor(config: ControlPlaneConnectionConfig) {
    this.#config = config
    this.#client = new ControlPlaneClient({
      baseUrl: config.baseUrl,
      nodeId: config.nodeId,
    })
  }

  get client(): ControlPlaneClient {
    return this.#client
  }

  setExecutionState(state: NodeExecutionState): void {
    this.#executionState = state
  }

  async start(): Promise<void> {
    this.#running = true

    await this.#register()
    this.#startHeartbeat()
    void this.#pollLoop()
  }

  stop(): void {
    this.#running = false
    this.#pollAbortController?.abort()
    this.#pollAbortController = null
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = null
    }
  }

  async #register(): Promise<void> {
    await this.#client.register({
      nodeId: this.#config.nodeId,
      enrollmentToken: this.#config.enrollmentToken,
      hostname: this.#config.hostname,
      platform: this.#config.platform,
      version: this.#config.version,
      agentList: this.#config.agentList,
    })
  }

  #startHeartbeat(): void {
    const interval = this.#config.heartbeatIntervalMs ?? 30000
    this.#heartbeatTimer = setInterval(() => {
      void this.#heartbeatOnce()
    }, interval)
  }

  async #heartbeatOnce(): Promise<void> {
    try {
      await this.#client.heartbeat(this.#executionState)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        await this.#reRegister()
      }
    }
  }

  async #pollLoop(): Promise<void> {
    while (this.#running) {
      this.#pollAbortController = new AbortController()

      try {
        const command = await this.#client.pollCommand(30000, this.#pollAbortController.signal)
        if (command !== null) {
          this.#config.onCommand(command)
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }
        if (error instanceof ControlPlaneAuthError) {
          await this.#reRegister()
        } else {
          await sleep(1000)
        }
      } finally {
        this.#pollAbortController = null
      }
    }
  }

  async #reRegister(): Promise<void> {
    try {
      await this.#register()
    } catch {
      await sleep(1000)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
