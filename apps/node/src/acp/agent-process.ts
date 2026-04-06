/**
 * Agent subprocess manager.
 *
 * 负责 spawn ACP agent 子进程（原生或外部 CLI），
 * 管理进程生命周期，提供 stdin/stdout stream 给 ACP 连接使用。
 *
 * @module acp/agent-process
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import type { RuntimeLogger } from '../logger.js'

export interface AgentProcessConfig {
  readonly agentId: string
  /** 可执行命令，如 `tianji-agent`、`claude`、`codex` */
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
  readonly logger?: RuntimeLogger
}

export class AgentProcessManager {
  readonly agentId: string
  readonly #config: AgentProcessConfig
  readonly #logger: RuntimeLogger | undefined
  #process: ChildProcess | null = null

  constructor(config: AgentProcessConfig) {
    this.agentId = config.agentId
    this.#config = config
    this.#logger = config.logger
  }

  get isRunning(): boolean {
    return this.#process !== null && this.#process.exitCode === null
  }

  /**
   * Spawn agent 子进程，返回 Web Stream 供 ACP SDK 使用。
   */
  spawn(): { input: ReadableStream<Uint8Array>; output: WritableStream<Uint8Array> } {
    if (this.#process !== null) {
      throw new Error(`Agent ${this.agentId} is already running`)
    }

    this.#process = spawn(this.#config.command, [...(this.#config.args ?? [])], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...this.#config.env },
    })

    void this.#logger?.logInfo(['acp', 'process'], 'Agent process spawned', {
      agentId: this.agentId,
      command: this.#config.command,
      pid: this.#process.pid,
    })

    const currentProcess = this.#process
    currentProcess.on('exit', (code, signal) => {
      void this.#logger?.logInfo(['acp', 'process'], 'Agent process exited', {
        agentId: this.agentId,
        pid: currentProcess.pid,
        code,
        signal,
      })
      this.#process = null
    })

    const stdout = this.#process.stdout
    const stdin = this.#process.stdin
    if (!stdout || !stdin) {
      throw new Error(`Agent ${this.agentId} stdio is not available`)
    }

    return {
      input: Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
      output: Writable.toWeb(stdin) as WritableStream<Uint8Array>,
    }
  }

  /** 终止 agent 子进程。 */
  async kill(): Promise<void> {
    if (this.#process === null) {
      return
    }

    const currentProcess = this.#process
    currentProcess.kill('SIGTERM')

    void this.#logger?.logDebug(['acp', 'process'], 'Sent SIGTERM to agent process', {
      agentId: this.agentId,
      pid: currentProcess.pid,
    })

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        void this.#logger?.logWarn(
          ['acp', 'process'],
          'Agent process did not exit in time, sent SIGKILL',
          {
            agentId: this.agentId,
            pid: currentProcess.pid,
          }
        )
        currentProcess.kill('SIGKILL')
        resolve()
      }, 5000)

      currentProcess.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    this.#process = null
  }
}
