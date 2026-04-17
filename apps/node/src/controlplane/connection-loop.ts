/**
 * Control Plane connection lifecycle loop.
 *
 * @module controlplane/connection-loop
 */

import type { AgentInfo, NodeExecutionState, NodeId, PollCommandResponse } from '@tianji/shared'

import { errorToLogData } from '@tianji/observer'
import type { RuntimeLogger } from '../logger.js'
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
  readonly emptyPollBackoffMs?: number
  readonly onCommand: (command: PollCommandResponse) => void
  readonly onConnectionStateChange?: (event: {
    status:
      | 'connecting'
      | 'connected'
      | 'heartbeat_succeeded'
      | 'heartbeat_failed'
      | 'register_failed'
    error?: string
  }) => void
  readonly logger?: RuntimeLogger
}

export class ControlPlaneConnection {
  readonly #config: ControlPlaneConnectionConfig
  readonly #client: ControlPlaneClient
  readonly #scope = ['daemon', 'controlplane'] as const
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
    this.#config.onConnectionStateChange?.({ status: 'connecting' })

    await this.#register()
    this.#config.onConnectionStateChange?.({ status: 'connected' })
    this.#startHeartbeat()
    this.#runInBackground(() => this.#pollLoop())
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
      pid: process.pid,
    })
  }

  #startHeartbeat(): void {
    const interval = this.#config.heartbeatIntervalMs ?? 30000
    this.#heartbeatTimer = setInterval(() => {
      this.#runInBackground(() => this.#heartbeatOnce())
    }, interval)
  }

  /**
   * 启动后台异步任务，并吞掉最外层 rejection，避免 daemon 因未处理拒绝退出。
   */
  #runInBackground(task: () => Promise<void>): void {
    void task().catch(async (error) => {
      try {
        await this.#config.logger?.logError(this.#scope, 'Control plane background task failed', {
          ...errorToLogData(error),
        })
      } catch {
        // 后台兜底日志也失败时，直接吞掉，避免再次触发 unhandledRejection。
      }
    })
  }

  async #heartbeatOnce(): Promise<void> {
    await this.#config.logger?.logDebug(this.#scope, 'Sending control plane heartbeat', {
      nodeId: this.#config.nodeId,
      executionState: this.#executionState,
      baseUrl: this.#config.baseUrl,
    })
    try {
      await this.#client.heartbeat(this.#executionState, undefined, process.pid)
      this.#config.onConnectionStateChange?.({ status: 'heartbeat_succeeded' })
      await this.#config.logger?.logDebug(this.#scope, 'Control plane heartbeat sent', {
        nodeId: this.#config.nodeId,
        executionState: this.#executionState,
      })
    } catch (error) {
      const errorData = errorToLogData(error)

      this.#config.onConnectionStateChange?.({
        status: 'heartbeat_failed',
        error: typeof errorData.message === 'string' ? errorData.message : String(error),
      })
      await this.#config.logger?.logError(this.#scope, 'Control plane heartbeat failed', {
        nodeId: this.#config.nodeId,
        executionState: this.#executionState,
        baseUrl: this.#config.baseUrl,
        ...errorData,
      })
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
        if (command === null) {
          await sleep(this.#config.emptyPollBackoffMs ?? 25)
        } else {
          await this.#config.logger?.logInfo(this.#scope, 'Received control plane task', {
            commandId: command.commandId,
            taskId: command.payload.taskId,
            type: command.type,
            ...(command.type === 'task.run' ? { agentId: command.payload.agentId } : {}),
          })
          await this.#config.logger?.logDebug(this.#scope, 'Received control plane task detail', {
            command,
          })
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
      this.#config.onConnectionStateChange?.({ status: 'connected' })
    } catch {
      this.#config.onConnectionStateChange?.({ status: 'register_failed' })
      await sleep(1000)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
