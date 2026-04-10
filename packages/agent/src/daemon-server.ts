import { unlink, writeFile } from 'node:fs/promises'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'

import type { AgentAppPaths } from './context.js'
import {
  type ChatErrorSseMessage,
  type ChatRequestBody,
  type ChatSseMessage,
  type ControlPlaneStatusSnapshot,
  DAEMON_SSE_DONE_NAME,
  DAEMON_SSE_ERROR_NAME,
  DAEMON_SSE_EVENT_NAME,
  DEFAULT_CONTROL_PLANE_STATUS,
  type PingResponse,
  type ShutdownResponse,
  encodeSseMessage,
} from './daemon-protocol.js'
import type { AgentExecutorFactory, OrchestrationGraph } from './orchestration/index.js'
import type { AgentSession, ChatWithGraphOptions } from './session.js'

export interface DaemonServerOptions {
  readonly session: AgentSession
  readonly defaultGraph: OrchestrationGraph
  readonly executorFactory: AgentExecutorFactory
  readonly paths?: Pick<AgentAppPaths, 'daemonPortPath' | 'daemonPidPath'>
  readonly getControlPlaneStatus?: () => ControlPlaneStatusSnapshot
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

export class DaemonServer {
  readonly #session: AgentSession
  readonly #defaultGraph: OrchestrationGraph
  readonly #executorFactory: AgentExecutorFactory
  readonly #paths: Pick<AgentAppPaths, 'daemonPortPath' | 'daemonPidPath'> | undefined
  readonly #server: Server
  readonly #getControlPlaneStatus: (() => ControlPlaneStatusSnapshot) | undefined
  #startedAt: number
  #chatInProgress: boolean
  #shutdownPromise: Promise<void> | undefined

  constructor(options: DaemonServerOptions) {
    this.#session = options.session
    this.#defaultGraph = options.defaultGraph
    this.#executorFactory = options.executorFactory
    this.#paths = options.paths
    this.#getControlPlaneStatus = options.getControlPlaneStatus
    this.#server = createServer((req, res) => {
      void this.#handleRequest(req, res)
    })
    this.#startedAt = 0
    this.#chatInProgress = false
    this.#shutdownPromise = undefined
  }

  get port(): number {
    const addr = this.#server.address()
    if (addr === null || typeof addr === 'string') {
      return 0
    }
    return addr.port
  }

  /**
   * Starts listening on the given port (0 for random).
   * Writes port and pid files if paths were provided.
   */
  listen(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(port, '127.0.0.1', () => {
        this.#server.removeListener('error', reject)
        this.#startedAt = Date.now()
        void this.#writeStateFiles().then(resolve, reject)
      })
    })
  }

  /**
   * Gracefully shuts down the server.
   * Waits for active chats to finish, deletes port/pid files.
   * Idempotent: subsequent calls return the same promise.
   */
  shutdown(): Promise<void> {
    if (this.#shutdownPromise) {
      return this.#shutdownPromise
    }

    this.#shutdownPromise = this.#performShutdown()
    return this.#shutdownPromise
  }

  async #performShutdown(): Promise<void> {
    await this.#waitForChat()
    await new Promise<void>((resolve, reject) => {
      this.#server.close((err) => (err ? reject(err) : resolve()))
    })
  }

  /**
   * 删除 port/pid 状态文件。应在进程即将退出时调用，
   * 而非在 HTTP server 关闭后立刻删除——避免 CLI 误判进程已退出。
   */
  async deleteStateFiles(): Promise<void> {
    await this.#deleteStateFiles()
  }

  #waitForChat(timeoutMs = 10_000): Promise<void> {
    if (!this.#chatInProgress) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const deadline = Date.now() + timeoutMs
      const interval = setInterval(() => {
        if (!this.#chatInProgress || Date.now() >= deadline) {
          clearInterval(interval)
          resolve()
        }
      }, 20)
    })
  }

  async #handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    if (req.method === 'GET' && url.pathname === '/ping') {
      return this.#handlePing(res)
    }

    if (req.method === 'POST' && url.pathname === '/chat') {
      return this.#handleChat(req, res)
    }

    if (req.method === 'POST' && url.pathname === '/shutdown') {
      return this.#handleShutdown(res)
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  }

  #handlePing(res: ServerResponse): void {
    const body: PingResponse = {
      sessionId: this.#session.sessionId as string,
      uptime: Math.floor((Date.now() - this.#startedAt) / 1000),
      pid: process.pid,
      controlPlane: this.#getControlPlaneStatus?.() ?? DEFAULT_CONTROL_PLANE_STATUS,
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  async #handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsed: ChatRequestBody
    try {
      parsed = await readJsonBody<ChatRequestBody>(req)
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid json body' }))
      return
    }

    if (typeof parsed.prompt !== 'string') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing prompt field' }))
      return
    }

    if (this.#chatInProgress) {
      this.#sendSse(res, DAEMON_SSE_ERROR_NAME, {
        type: 'chat.error',
        code: 'BUSY',
        message: 'A chat is already in progress',
      } satisfies ChatErrorSseMessage)
      res.end()
      return
    }

    this.#chatInProgress = true
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    try {
      const graphOptions: ChatWithGraphOptions = {
        initialState: { input: parsed.prompt },
        compileOptions: { agentExecutorFactory: this.#executorFactory },
      }
      for await (const event of this.#session.queryWithGraph(this.#defaultGraph, graphOptions)) {
        const message: ChatSseMessage = { type: 'chat.event', event }
        this.#sendSse(res, DAEMON_SSE_EVENT_NAME, message)
      }
      this.#sendSse(res, DAEMON_SSE_DONE_NAME, { type: 'chat.done' } satisfies ChatSseMessage)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      this.#sendSse(res, DAEMON_SSE_ERROR_NAME, {
        type: 'chat.error',
        code: 'INTERNAL',
        message,
      } satisfies ChatErrorSseMessage)
    } finally {
      this.#chatInProgress = false
      res.end()
    }
  }

  #handleShutdown(res: ServerResponse): void {
    const body: ShutdownResponse = { ok: true }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    void this.shutdown()
  }

  #sendSse(res: ServerResponse, event: string, data: ChatSseMessage): void {
    res.write(encodeSseMessage({ event, data }))
  }

  async #writeStateFiles(): Promise<void> {
    if (!this.#paths) return
    const { daemonPortPath, daemonPidPath } = this.#paths
    await writeFile(daemonPortPath, String(this.port), 'utf8')
    await writeFile(daemonPidPath, String(process.pid), 'utf8')
  }

  async #deleteStateFiles(): Promise<void> {
    if (!this.#paths) return
    const { daemonPortPath, daemonPidPath } = this.#paths
    await Promise.all([
      unlink(daemonPortPath).catch(() => {}),
      unlink(daemonPidPath).catch(() => {}),
    ])
  }
}
