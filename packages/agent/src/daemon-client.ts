import { type IncomingMessage, request } from 'node:http'

import type { RuntimeEvent } from '@tianji/shared'

import {
  type ChatErrorSseMessage,
  type ChatSseMessage,
  DAEMON_SSE_DONE_NAME,
  DAEMON_SSE_ERROR_NAME,
  type PingResponse,
  type ShutdownResponse,
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
  for await (const chunk of res) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
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

/** Handles a parsed SSE message: yields events, throws on errors, returns on done. */
function handleSseMessage(msg: RawSseMessage): IteratorResult<RuntimeEvent> {
  const parsed = JSON.parse(msg.data) as ChatSseMessage

  if (parsed.type === 'chat.error') {
    throw new Error((parsed as ChatErrorSseMessage).message)
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
  #host: string
  #port: number

  constructor(options: DaemonClientOptions) {
    this.#host = options.host
    this.#port = options.port
  }

  /** Sends a GET /ping request and returns session metadata. */
  async ping(): Promise<PingResponse> {
    const res = await httpRequest({
      host: this.#host,
      port: this.#port,
      method: 'GET',
      path: '/ping',
    })
    assertOk(res, '/ping')
    const body = await readBody(res)
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
    assertOk(res, '/shutdown')
    const body = await readBody(res)
    return JSON.parse(body) as ShutdownResponse
  }

  /**
   * Sends a POST /chat request and yields {@link RuntimeEvent} objects
   * from the SSE stream. Stops on `chat.done`, throws on `chat.error`.
   */
  async *sendChat(prompt: string): AsyncIterable<RuntimeEvent> {
    const body = JSON.stringify({ prompt })
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

        let newlineIdx = buffer.indexOf('\n')
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx)
          buffer = buffer.slice(newlineIdx + 1)
          newlineIdx = buffer.indexOf('\n')

          const message = parseSseLine(line, sseState)
          if (message) {
            const result = handleSseMessage(message)
            if (result.done) {
              return
            }
            yield result.value
          }
        }
      }

      // Flush any remaining content in the buffer
      for (const line of buffer.split('\n')) {
        const message = parseSseLine(line, sseState)
        if (message) {
          const result = handleSseMessage(message)
          if (result.done) {
            return
          }
          yield result.value
        }
      }
    } finally {
      res.destroy()
    }
  }
}
