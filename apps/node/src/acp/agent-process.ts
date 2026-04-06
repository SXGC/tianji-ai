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

export interface AgentProcessConfig {
  readonly agentId: string
  /** 可执行命令，如 `tianji-agent`、`claude`、`codex` */
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
}

export class AgentProcessManager {
  readonly agentId: string
  readonly #config: AgentProcessConfig
  #process: ChildProcess | null = null

  constructor(config: AgentProcessConfig) {
    this.agentId = config.agentId
    this.#config = config
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

    this.#process.on('exit', () => {
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

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
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
