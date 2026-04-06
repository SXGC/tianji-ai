import { describe, expect, it } from 'vitest'

import {
  type ChatDoneSseMessage,
  type ChatErrorSseMessage,
  type ChatEventSseMessage,
  type ChatRequestBody,
  DAEMON_SSE_DONE_NAME,
  DAEMON_SSE_ERROR_NAME,
  DAEMON_SSE_EVENT_NAME,
  DEFAULT_CONTROL_PLANE_STATUS,
  type PingResponse,
  type ShutdownResponse,
  encodeSseMessage,
} from '../daemon-protocol.js'

describe('daemon-protocol constants', () => {
  it('defines SSE event names as const strings', () => {
    expect(DAEMON_SSE_EVENT_NAME).toBe('chat.event')
    expect(DAEMON_SSE_DONE_NAME).toBe('chat.done')
    expect(DAEMON_SSE_ERROR_NAME).toBe('chat.error')
  })
})

describe('encodeSseMessage', () => {
  it('encodes a chat.event message with RuntimeEvent data', () => {
    const eventMessage: ChatEventSseMessage = {
      type: 'chat.event',
      event: {
        type: 'message.delta',
        runId: 'run-123' as never,
        messageId: 'msg-1',
        sequence: 0,
        channel: 'text',
        payload: { content: 'hello' },
        timestamp: 1000,
      },
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
  it('ChatRequestBody accepts prompt', () => {
    const body: ChatRequestBody = { prompt: 'hello' }
    expect(body.prompt).toBe('hello')
  })

  it('PingResponse has sessionId, uptime, and pid', () => {
    const response: PingResponse = {
      sessionId: 'sess-1',
      uptime: 42,
      pid: 1234,
      controlPlane: DEFAULT_CONTROL_PLANE_STATUS,
    }
    expect(response.sessionId).toBe('sess-1')
    expect(response.uptime).toBe(42)
    expect(response.pid).toBe(1234)
    expect(response.controlPlane.status).toBe('disabled')
  })

  it('ShutdownResponse has ok true', () => {
    const response: ShutdownResponse = { ok: true }
    expect(response.ok).toBe(true)
  })
})
