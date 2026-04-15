import { readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { DomainEvent } from '@tianji/shared'

import {
  type ControlPlaneStatusSnapshot,
  DAEMON_SSE_DONE_NAME,
  DAEMON_SSE_EVENT_NAME,
} from '../daemon-protocol.js'
import type { ChatDoneSseMessage, ChatErrorSseMessage, PingResponse } from '../daemon-protocol.js'
import { DaemonServer, type DaemonServerOptions } from '../daemon-server.js'
import type { AgentExecutorFactory, OrchestrationGraph } from '../orchestration/index.js'
import type { AgentSession } from '../session.js'

/** 最小可用的空编排图存根，测试中不会真正执行。 */
const STUB_GRAPH: OrchestrationGraph = {
  id: 'stub',
  name: 'stub',
  version: 1,
  source: 'static',
  locked: false,
  state: {},
  nodes: [],
  edges: [],
}

/** 不会被调用的执行器工厂存根。 */
const STUB_EXECUTOR_FACTORY: AgentExecutorFactory = () => {
  throw new Error('stub executor factory should not be called')
}

function createStubSession(events: DomainEvent[] = []): AgentSession {
  return {
    sessionId: 'session_test' as unknown as AgentSession['sessionId'],
    abort: () => undefined,
    close: () => undefined,
    async *queryWithGraph(_graph, _options) {
      for (const event of events) {
        yield event
      }
    },
  }
}

function createBlockingSession(): AgentSession & { resolve: () => void } {
  let resolve!: () => void
  const barrier = new Promise<void>((r) => {
    resolve = r
  })
  return {
    sessionId: 'session_blocking' as unknown as AgentSession['sessionId'],
    resolve,
    abort: () => undefined,
    close: () => undefined,
    async *queryWithGraph(_graph, _options) {
      yield await barrier.then((): DomainEvent => ({ type: 'RunCompleted' }) as DomainEvent)
    },
  }
}

function baseUrl(server: DaemonServer): string {
  return `http://127.0.0.1:${server.port}`
}

function parseSseBlocks(text: string): Array<{ event: string; data: string }> {
  const blocks: Array<{ event: string; data: string }> = []
  let currentEvent = ''
  let currentData = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7)
    } else if (line.startsWith('data: ')) {
      currentData = line.slice(6)
    } else if (line === '' && currentEvent && currentData) {
      blocks.push({ event: currentEvent, data: currentData })
      currentEvent = ''
      currentData = ''
    }
  }
  return blocks
}

describe('DaemonServer', () => {
  let server: DaemonServer

  afterEach(async () => {
    if (server) {
      await server.shutdown()
    }
  })

  it('GET /ping returns session metadata', async () => {
    const session = createStubSession()
    server = new DaemonServer({
      session,
      defaultGraph: STUB_GRAPH,
      executorFactory: STUB_EXECUTOR_FACTORY,
    })
    await server.listen(0)

    const res = await fetch(`${baseUrl(server)}/ping`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as PingResponse
    expect(body.sessionId).toBe('session_test')
    expect(typeof body.pid).toBe('number')
    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
    expect(body.controlPlane).toEqual({
      enabled: false,
      status: 'disabled',
      baseUrl: null,
      lastSuccessAt: null,
      lastError: null,
    } satisfies ControlPlaneStatusSnapshot)
  })

  it('GET /ping returns controlplane snapshot from getter', async () => {
    const session = createStubSession()
    const controlPlane: ControlPlaneStatusSnapshot = {
      enabled: true,
      status: 'degraded',
      baseUrl: 'http://127.0.0.1:3000',
      lastSuccessAt: 123,
      lastError: 'fetch failed',
    }
    server = new DaemonServer({
      session,
      defaultGraph: STUB_GRAPH,
      executorFactory: STUB_EXECUTOR_FACTORY,
      getControlPlaneStatus: () => controlPlane,
    })
    await server.listen(0)

    const res = await fetch(`${baseUrl(server)}/ping`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as PingResponse
    expect(body.controlPlane).toEqual(controlPlane)
  })

  it('POST /chat streams chat events and terminates with chat.done', async () => {
    const events = [
      { type: 'MessageDelta', content: 'hello' } as unknown as DomainEvent,
      { type: 'MessageDelta', content: ' world' } as unknown as DomainEvent,
    ]
    const session = createStubSession(events)
    server = new DaemonServer({
      session,
      defaultGraph: STUB_GRAPH,
      executorFactory: STUB_EXECUTOR_FACTORY,
    })
    await server.listen(0)

    const res = await fetch(`${baseUrl(server)}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/event-stream')

    const text = await res.text()
    const blocks = parseSseBlocks(text)

    expect(blocks.length).toBe(3)

    expect(blocks[0].event).toBe(DAEMON_SSE_EVENT_NAME)
    const parsed0 = JSON.parse(blocks[0].data)
    expect(parsed0.type).toBe('chat.event')

    expect(blocks[1].event).toBe(DAEMON_SSE_EVENT_NAME)
    const parsed1 = JSON.parse(blocks[1].data)
    expect(parsed1.type).toBe('chat.event')

    expect(blocks[2].event).toBe(DAEMON_SSE_DONE_NAME)
    const parsed2 = JSON.parse(blocks[2].data) as ChatDoneSseMessage
    expect(parsed2.type).toBe('chat.done')
  })

  it('concurrent chat returns BUSY error', async () => {
    const blockingSession = createBlockingSession()
    server = new DaemonServer({
      session: blockingSession,
      defaultGraph: STUB_GRAPH,
      executorFactory: STUB_EXECUTOR_FACTORY,
    })
    await server.listen(0)

    const chat1 = fetch(`${baseUrl(server)}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'first' }),
    })

    await new Promise((r) => setTimeout(r, 50))

    const res2 = await fetch(`${baseUrl(server)}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'second' }),
    })

    expect(res2.status).toBe(200)
    const text2 = await res2.text()
    const blocks = parseSseBlocks(text2)
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    expect(blocks[0].event).toBe('chat.error')
    const parsed = JSON.parse(blocks[0].data) as ChatErrorSseMessage
    expect(parsed.type).toBe('chat.error')
    expect(parsed.code).toBe('BUSY')

    blockingSession.resolve()
    await chat1
  })

  it('deleteStateFiles cleans pid/port files after shutdown', async () => {
    const portPath = join(tmpdir(), `tianji-test-daemon-port-${Date.now()}`)
    const pidPath = join(tmpdir(), `tianji-test-daemon-pid-${Date.now()}`)

    const session = createStubSession()
    const opts: DaemonServerOptions = {
      session,
      defaultGraph: STUB_GRAPH,
      executorFactory: STUB_EXECUTOR_FACTORY,
      paths: {
        daemonPortPath: portPath,
        daemonPidPath: pidPath,
      },
    }
    server = new DaemonServer(opts)
    await server.listen(0)

    const portContent = await readFile(portPath, 'utf8')
    expect(Number(portContent)).toBe(server.port)

    const pidContent = await readFile(pidPath, 'utf8')
    expect(Number(pidContent)).toBe(process.pid)

    await server.shutdown()
    await expect(stat(portPath)).resolves.toBeDefined()
    await expect(stat(pidPath)).resolves.toBeDefined()

    await server.deleteStateFiles()
    await expect(stat(portPath)).rejects.toThrow()
    await expect(stat(pidPath)).rejects.toThrow()
  })

  it('shutdown is idempotent', async () => {
    const session = createStubSession()
    server = new DaemonServer({
      session,
      defaultGraph: STUB_GRAPH,
      executorFactory: STUB_EXECUTOR_FACTORY,
    })
    await server.listen(0)

    await server.shutdown()
    await expect(server.shutdown()).resolves.not.toThrow()
  })

  it('returns 404 for unknown routes', async () => {
    const session = createStubSession()
    server = new DaemonServer({
      session,
      defaultGraph: STUB_GRAPH,
      executorFactory: STUB_EXECUTOR_FACTORY,
    })
    await server.listen(0)

    const res = await fetch(`${baseUrl(server)}/unknown`)
    expect(res.status).toBe(404)
  })

  it('POST /chat with invalid body returns 400', async () => {
    const session = createStubSession()
    server = new DaemonServer({
      session,
      defaultGraph: STUB_GRAPH,
      executorFactory: STUB_EXECUTOR_FACTORY,
    })
    await server.listen(0)

    const res = await fetch(`${baseUrl(server)}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ notPrompt: 'hello' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /chat handles internal errors from session', async () => {
    const errorSession: AgentSession = {
      sessionId: 'session_error' as unknown as AgentSession['sessionId'],
      abort: () => undefined,
      async *queryWithGraph(_graph, _options) {
        yield await Promise.reject(new Error('boom'))
      },
    }
    server = new DaemonServer({
      session: errorSession,
      defaultGraph: STUB_GRAPH,
      executorFactory: STUB_EXECUTOR_FACTORY,
    })
    await server.listen(0)

    const res = await fetch(`${baseUrl(server)}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    })
    expect(res.status).toBe(200)

    const text = await res.text()
    const blocks = parseSseBlocks(text)
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    const parsed = JSON.parse(blocks[0].data) as ChatErrorSseMessage
    expect(parsed.type).toBe('chat.error')
    expect(parsed.code).toBe('INTERNAL')
  })
})
