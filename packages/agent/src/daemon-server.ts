import { unlink, writeFile } from 'node:fs/promises'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'

import type { EventBus, SessionId } from '@tianji/shared'

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
import type { UnifiedRuntimeEntry } from './unified-entry.js'

export interface DaemonServerOptions {
  readonly entry: UnifiedRuntimeEntry
  readonly bus: EventBus
  readonly paths?: Pick<AgentAppPaths, 'daemonPortPath' | 'daemonPidPath'>
  readonly getControlPlaneStatus?: () => ControlPlaneStatusSnapshot
  /**
   * 可选：在每次 /chat 请求前建立独立的因果链上下文。
   * 由装配层注入（例如 AsyncLocalStorage.run 包裹），确保并发请求间因果链不互相污染。
   * 若未提供，/chat handler 直接执行（不建立独立上下文）。
   *
   * @param correlationId - 本次请求的关联 ID
   * @param fn - 在独立上下文内执行的 handler 体
   */
  readonly enterCorrelation?: (correlationId: string, fn: () => Promise<void>) => Promise<void>
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function createDaemonSessionId(): SessionId {
  return `session_${Date.now()}_${crypto.randomUUID()}` as SessionId
}

export class DaemonServer {
  readonly #entry: UnifiedRuntimeEntry
  readonly #bus: EventBus
  readonly #paths: Pick<AgentAppPaths, 'daemonPortPath' | 'daemonPidPath'> | undefined
  readonly #server: Server
  readonly #getControlPlaneStatus: (() => ControlPlaneStatusSnapshot) | undefined
  readonly #enterCorrelation:
    | ((correlationId: string, fn: () => Promise<void>) => Promise<void>)
    | undefined
  #startedAt: number
  #activeSessionInProgress: boolean
  #shutdownPromise: Promise<void> | undefined

  constructor(options: DaemonServerOptions) {
    this.#entry = options.entry
    this.#bus = options.bus
    this.#paths = options.paths
    this.#getControlPlaneStatus = options.getControlPlaneStatus
    this.#enterCorrelation = options.enterCorrelation
    this.#server = createServer((req, res) => {
      void this.#handleRequest(req, res)
    })
    this.#startedAt = 0
    this.#activeSessionInProgress = false
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
    if (!this.#activeSessionInProgress) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      const deadline = Date.now() + timeoutMs
      const interval = setInterval(() => {
        if (!this.#activeSessionInProgress || Date.now() >= deadline) {
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

    if (req.method === 'POST' && url.pathname === '/sessions') {
      return this.#handleCreateSession(res)
    }

    if (req.method === 'POST' && url.pathname === '/shutdown') {
      return this.#handleShutdown(res)
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  }

  #handlePing(res: ServerResponse): void {
    const body: PingResponse = {
      uptime: Math.floor((Date.now() - this.#startedAt) / 1000),
      pid: process.pid,
      controlPlane: this.#getControlPlaneStatus?.() ?? DEFAULT_CONTROL_PLANE_STATUS,
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  #handleCreateSession(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ sessionId: createDaemonSessionId() }))
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

    if (typeof parsed.prompt !== 'string' || typeof parsed.sessionId !== 'string') {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing prompt or sessionId field' }))
      return
    }

    if (this.#activeSessionInProgress) {
      this.#sendSse(res, DAEMON_SSE_ERROR_NAME, {
        type: 'chat.error',
        code: 'ACTIVE_SESSION_CONCURRENCY_UNSUPPORTED',
        message: 'The daemon currently supports only one active session at a time',
      } satisfies ChatErrorSseMessage)
      res.end()
      return
    }

    this.#activeSessionInProgress = true
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    // 每次 /chat 请求生成独立 correlationId，用 enterCorrelation（若注入）建立隔离的因果链上下文。
    const correlationId = crypto.randomUUID()

    const runChat = async (): Promise<void> => {
      const subscription = this.#bus.subscribe(
        { aggregateType: ['GraphRun', 'Run'] },
        (env) => {
          this.#sendSse(res, DAEMON_SSE_EVENT_NAME, { type: 'chat.event', event: env })
        },
        { name: 'daemon-sse', queueSize: 2_000 }
      )
      try {
        const handle = await this.#entry.run({
          source: 'daemon',
          input: parsed.prompt,
          sessionId: parsed.sessionId as SessionId,
        })
        for await (const _event of handle.events) {
          // intentionally empty — events are delivered via bus subscription
        }
        this.#sendSse(res, DAEMON_SSE_DONE_NAME, { type: 'chat.done' } satisfies ChatSseMessage)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        const code =
          typeof err === 'object' &&
          err !== null &&
          'code' in err &&
          err.code === 'SESSION_NOT_FOUND'
            ? 'SESSION_NOT_FOUND'
            : 'INTERNAL'
        this.#sendSse(res, DAEMON_SSE_ERROR_NAME, {
          type: 'chat.error',
          code,
          message,
        } satisfies ChatErrorSseMessage)
      } finally {
        subscription.unsubscribe()
        this.#activeSessionInProgress = false
        res.end()
      }
    }

    if (this.#enterCorrelation !== undefined) {
      void this.#enterCorrelation(correlationId, runChat)
    } else {
      void runChat()
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
