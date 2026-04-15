import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import type { DomainEventEnvelope } from '@tianji/shared'

import { DaemonClient, type DaemonClientOptions } from '../daemon-client.js'
import {
  DAEMON_SSE_DONE_NAME,
  DAEMON_SSE_ERROR_NAME,
  DAEMON_SSE_EVENT_NAME,
  encodeSseMessage,
} from '../daemon-protocol.js'
import type { ChatErrorSseMessage, ChatSseMessage } from '../daemon-protocol.js'

/** 构造最小合法的 DomainEventEnvelope 用于客户端测试。 */
function makeEnvelope(overrides: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope {
  return {
    eventId: 'evt-1',
    type: 'RunStarted',
    occurredAt: '2026-04-14T00:00:00Z',
    correlationId: 'corr-1',
    causationId: null,
    sequence: 1,
    aggregateType: 'Run',
    aggregateId: 'run-1',
    source: { processKind: 'daemon', processId: 'proc-1' },
    payload: {} as never,
    ...overrides,
  }
}

function writeJson(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
}

function sseEvent(event: DomainEventEnvelope): string {
  const msg: ChatSseMessage = { type: 'chat.event', event }
  return encodeSseMessage({ event: DAEMON_SSE_EVENT_NAME, data: msg })
}

function sseDone(): string {
  return encodeSseMessage({ event: DAEMON_SSE_DONE_NAME, data: { type: 'chat.done' } })
}

function sseError(code: 'BUSY' | 'INTERNAL', message: string): string {
  const msg: ChatErrorSseMessage = { type: 'chat.error', code, message }
  return encodeSseMessage({ event: DAEMON_SSE_ERROR_NAME, data: msg })
}

async function setupServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ client: DaemonClient; close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  const client = new DaemonClient({ host: '127.0.0.1', port })
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })
  return { client, close }
}

describe('DaemonClient', () => {
  let closeServer: (() => Promise<void>) | undefined

  afterEach(async () => {
    if (closeServer) {
      await closeServer()
      closeServer = undefined
    }
  })

  it('ping returns PingResponse', async () => {
    const pingBody = { sessionId: 'abc-123', uptime: 42, pid: 9999 }
    const { client, close } = await setupServer((req, res) => {
      closeServer = close
      if (req.method === 'GET' && req.url === '/ping') {
        writeJson(res, pingBody)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    closeServer = close

    const result = await client.ping()
    expect(result).toEqual(pingBody)
  })

  it('shutdown returns ShutdownResponse', async () => {
    const { client, close } = await setupServer((req, res) => {
      if (req.method === 'POST' && req.url === '/shutdown') {
        writeJson(res, { ok: true })
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    closeServer = close

    const result = await client.shutdown()
    expect(result).toEqual({ ok: true })
  })

  it('sendChat yields DomainEventEnvelope objects from SSE stream', async () => {
    const env1 = makeEnvelope({ eventId: 'evt-1', type: 'RunStarted' })
    const env2 = makeEnvelope({ eventId: 'evt-2', type: 'RunCompleted' })

    const { client, close } = await setupServer((req, res) => {
      if (req.method === 'POST' && req.url === '/chat') {
        writeSseHeaders(res)
        res.write(sseEvent(env1))
        res.write(sseEvent(env2))
        res.write(sseDone())
        res.end()
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    closeServer = close

    const collected: DomainEventEnvelope[] = []
    for await (const env of client.sendChat('hi')) {
      collected.push(env)
    }

    expect(collected).toEqual([env1, env2])
  })

  it('sendChat throws on BUSY error from SSE', async () => {
    const { client, close } = await setupServer((req, res) => {
      if (req.method === 'POST' && req.url === '/chat') {
        writeSseHeaders(res)
        res.write(sseError('BUSY', 'A chat is already in progress'))
        res.end()
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    closeServer = close

    await expect(async () => {
      for await (const _ of client.sendChat('hi')) {
        // consume
      }
    }).rejects.toThrow('A chat is already in progress')
  })

  it('sendChat throws on INTERNAL error from SSE', async () => {
    const { client, close } = await setupServer((req, res) => {
      if (req.method === 'POST' && req.url === '/chat') {
        writeSseHeaders(res)
        res.write(sseError('INTERNAL', 'Something went wrong'))
        res.end()
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    closeServer = close

    await expect(async () => {
      for await (const _ of client.sendChat('hi')) {
        // consume
      }
    }).rejects.toThrow('Something went wrong')
  })

  it('ping throws on non-2xx status', async () => {
    const { client, close } = await setupServer((req, res) => {
      res.writeHead(500)
      res.end('internal error')
    })
    closeServer = close

    await expect(client.ping()).rejects.toThrow('Request to /ping failed with status 500')
  })

  it('shutdown throws on non-2xx status', async () => {
    const { client, close } = await setupServer((req, res) => {
      res.writeHead(503)
      res.end('unavailable')
    })
    closeServer = close

    await expect(client.shutdown()).rejects.toThrow('Request to /shutdown failed with status 503')
  })

  it('sendChat throws on non-2xx status', async () => {
    const { client, close } = await setupServer((req, res) => {
      res.writeHead(500)
      res.end('fail')
    })
    closeServer = close

    await expect(async () => {
      for await (const _ of client.sendChat('hi')) {
        // consume
      }
    }).rejects.toThrow('Request to /chat failed with status 500')
  })
})
