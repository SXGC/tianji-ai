import { type IncomingMessage, request } from 'node:http'

import type { DomainEventEnvelope, SessionId } from '@tianji/shared'

import type {
  ChatErrorSseMessage,
  ChatSseMessage,
  CreateSessionResponse,
  PingResponse,
  ShutdownResponse,
} from './daemon-protocol.js'

export interface DaemonClientOptions {
  readonly host: string
  readonly port: number
}

type RawSseMessage = { readonly event: string; readonly data: string }

function httpRequest(
  opts: { host: string; port: number; method: string; path: string },
  body?: string
): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        hostname: opts.host,
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: body
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
          : undefined,
      },
      resolve
    )
    req.on('error', reject)
    if (body) {
      req.write(body)
    }
    req.end()
  })
}

async function readBody(res: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  try {
    for await (const chunk of res) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    }
  } finally {
    // 确保短连接请求在读取完成后立即释放底层 socket，避免 CLI 进程被挂住。
    res.destroy()
  }

  return Buffer.concat(chunks).toString('utf8')
}

/** Throws if the response status code is not 2xx. */
function assertOk(res: IncomingMessage, path: string): void {
  if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Request to ${path} failed with status ${res.statusCode ?? 'unknown'}`)
  }
}

/**
 * Parses a single SSE line and returns a complete message when a blank line
 * terminates the current event block. Uses caller-provided mutable state so
 * each invocation site gets its own isolated parser.
 */
function parseSseLine(line: string, state: { event: string; data: string }): RawSseMessage | null {
  if (line.startsWith('event: ')) {
    state.event = line.slice(7)
    return null
  }
  if (line.startsWith('data: ')) {
    state.data = line.slice(6)
    return null
  }
  if (line === '' && (state.event || state.data)) {
    const msg: RawSseMessage = { event: state.event, data: state.data }
    state.event = ''
    state.data = ''
    return msg
  }
  return null
}

/**
 * Processes a list of SSE lines, yielding DomainEventEnvelopes.
 * Returns true if the stream is done and the caller should stop.
 */
function* drainSseLines(
  lines: string[],
  sseState: { event: string; data: string }
): Generator<DomainEventEnvelope, boolean> {
  for (const line of lines) {
    const message = parseSseLine(line, sseState)
    if (!message) continue
    const result = handleSseMessage(message)
    if (result.done) return true
    yield result.value
  }
  return false
}

/** Handles a parsed SSE message: yields envelopes, throws on errors, returns on done. */
function handleSseMessage(msg: RawSseMessage): IteratorResult<DomainEventEnvelope> {
  const parsed = JSON.parse(msg.data) as ChatSseMessage

  if (parsed.type === 'chat.error') {
    throw new Error((parsed as ChatErrorSseMessage).message) // NOSONAR
  }
  if (parsed.type === 'chat.done') {
    return { done: true, value: undefined }
  }
  if (parsed.type === 'chat.event') {
    return { done: false, value: parsed.event }
  }
  return { done: true, value: undefined }
}

export class DaemonClient {
  readonly #host: string
  readonly #port: number
  #lastResponse: IncomingMessage | undefined

  constructor(options: DaemonClientOptions) {
    this.#host = options.host
    this.#port = options.port
  }

  /**
   * 关闭最近一次短连接请求残留的响应 socket，避免 CLI 进程被挂住。
   */
  close(): void {
    this.#lastResponse?.destroy()
    this.#lastResponse = undefined
  }

  /** Sends a GET /ping request and returns session metadata. */
  async ping(): Promise<PingResponse> {
    const res = await httpRequest({
      host: this.#host,
      port: this.#port,
      method: 'GET',
      path: '/ping',
    })
    this.#lastResponse = res
    assertOk(res, '/ping')
    const body = await readBody(res)
    this.#lastResponse = undefined
    return JSON.parse(body) as PingResponse
  }

  /** Sends a POST /shutdown request and returns confirmation. */
  async shutdown(): Promise<ShutdownResponse> {
    const res = await httpRequest({
      host: this.#host,
      port: this.#port,
      method: 'POST',
      path: '/shutdown',
    })
    this.#lastResponse = res
    assertOk(res, '/shutdown')
    const body = await readBody(res)
    this.#lastResponse = undefined
    return JSON.parse(body) as ShutdownResponse
  }

  /** Sends a POST /sessions request and returns a new daemon session id. */
  async createSession(): Promise<CreateSessionResponse> {
    const res = await httpRequest({
      host: this.#host,
      port: this.#port,
      method: 'POST',
      path: '/sessions',
    })
    this.#lastResponse = res
    assertOk(res, '/sessions')
    const body = await readBody(res)
    this.#lastResponse = undefined
    return JSON.parse(body) as CreateSessionResponse
  }

  /**
   * Sends a POST /chat request and yields {@link DomainEventEnvelope} objects
   * from the SSE stream. Stops on `chat.done`, throws on `chat.error`.
   */
  async *sendChat(prompt: string, sessionId: SessionId): AsyncIterable<DomainEventEnvelope> {
    const body = JSON.stringify({ prompt, sessionId })
    const res = await httpRequest(
      { host: this.#host, port: this.#port, method: 'POST', path: '/chat' },
      body
    )
    assertOk(res, '/chat')

    try {
      const sseState = { event: '', data: '' }
      let buffer = ''

      for await (const chunk of res) {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        if (yield* drainSseLines(lines, sseState)) return
      }

      // Flush any remaining content in the buffer
      if (yield* drainSseLines(buffer.split('\n'), sseState)) return
    } finally {
      res.destroy()
    }
  }
}
