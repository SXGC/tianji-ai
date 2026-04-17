import { describe, expect, it } from 'vitest'

import type { DomainEventEnvelope, SessionId } from '@tianji/shared'

import {
  type ChatDoneSseMessage,
  type ChatErrorSseMessage,
  type ChatEventSseMessage,
  type ChatRequestBody,
  type CreateSessionResponse,
  DAEMON_SSE_DONE_NAME,
  DAEMON_SSE_ERROR_NAME,
  DAEMON_SSE_EVENT_NAME,
  DEFAULT_CONTROL_PLANE_STATUS,
  type PingResponse,
  type ShutdownResponse,
  encodeSseMessage,
} from '../daemon-protocol.js'

/** 构造最小合法的 DomainEventEnvelope 用于协议测试。 */
function makeEnvelope(overrides: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope {
  return {
    eventId: 'evt-test',
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

describe('daemon-protocol constants', () => {
  it('defines SSE event names as const strings', () => {
    expect(DAEMON_SSE_EVENT_NAME).toBe('chat.event')
    expect(DAEMON_SSE_DONE_NAME).toBe('chat.done')
    expect(DAEMON_SSE_ERROR_NAME).toBe('chat.error')
  })
})

describe('encodeSseMessage', () => {
  it('encodes a chat.event message with DomainEventEnvelope data', () => {
    const eventMessage: ChatEventSseMessage = {
      type: 'chat.event',
      event: makeEnvelope({ eventId: 'evt-enc', type: 'RunStarted' }),
    }

    const result = encodeSseMessage({ event: DAEMON_SSE_EVENT_NAME, data: eventMessage })

    expect(result).toBe(`event: chat.event\ndata: ${JSON.stringify(eventMessage)}\n\n`)
  })

  it('encodes a chat.done message', () => {
    const doneMessage: ChatDoneSseMessage = { type: 'chat.done' }

    const result = encodeSseMessage({ event: DAEMON_SSE_DONE_NAME, data: doneMessage })

    expect(result).toBe(`event: chat.done\ndata: ${JSON.stringify(doneMessage)}\n\n`)
  })

  it('encodes a chat.error message with BUSY code', () => {
    const errorMessage: ChatErrorSseMessage = {
      type: 'chat.error',
      code: 'BUSY',
      message: 'Daemon is busy',
    }

    const result = encodeSseMessage({ event: DAEMON_SSE_ERROR_NAME, data: errorMessage })

    expect(result).toBe(`event: chat.error\ndata: ${JSON.stringify(errorMessage)}\n\n`)
  })

  it('encodes a chat.error message with INTERNAL code', () => {
    const errorMessage: ChatErrorSseMessage = {
      type: 'chat.error',
      code: 'INTERNAL',
      message: 'Something went wrong',
    }

    const result = encodeSseMessage({ event: DAEMON_SSE_ERROR_NAME, data: errorMessage })

    expect(result).toBe(`event: chat.error\ndata: ${JSON.stringify(errorMessage)}\n\n`)
  })
})

describe('protocol type shapes', () => {
  it('ChatRequestBody requires prompt and sessionId', () => {
    const body: ChatRequestBody = { prompt: 'hello', sessionId: 'sess-1' as SessionId }
    expect(body.prompt).toBe('hello')
    expect(body.sessionId).toBe('sess-1')
  })

  it('CreateSessionResponse returns sessionId', () => {
    const response: CreateSessionResponse = { sessionId: 'sess-1' as SessionId }
    expect(response.sessionId).toBe('sess-1')
  })

  it('PingResponse has uptime and pid', () => {
    const response: PingResponse = {
      uptime: 42,
      pid: 1234,
      controlPlane: DEFAULT_CONTROL_PLANE_STATUS,
    }
    expect(response.uptime).toBe(42)
    expect(response.pid).toBe(1234)
    expect(response.controlPlane.status).toBe('disabled')
  })

  it('ShutdownResponse has ok true', () => {
    const response: ShutdownResponse = { ok: true }
    expect(response.ok).toBe(true)
  })
})
