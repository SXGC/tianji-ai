import type { DomainEventEnvelope, SessionId } from '@tianji/shared'

export const DAEMON_SSE_EVENT_NAME = 'chat.event' as const
export const DAEMON_SSE_DONE_NAME = 'chat.done' as const
export const DAEMON_SSE_ERROR_NAME = 'chat.error' as const

export interface ChatRequestBody {
  readonly prompt: string
  readonly sessionId: SessionId
}

export interface CreateSessionResponse {
  readonly sessionId: SessionId
}

export type ControlPlaneConnectionStatus = 'disabled' | 'connecting' | 'connected' | 'degraded'

export interface ControlPlaneStatusSnapshot {
  readonly enabled: boolean
  readonly status: ControlPlaneConnectionStatus
  readonly baseUrl: string | null
  readonly lastSuccessAt: number | null
  readonly lastError: string | null
}

export const DEFAULT_CONTROL_PLANE_STATUS: ControlPlaneStatusSnapshot = {
  enabled: false,
  status: 'disabled',
  baseUrl: null,
  lastSuccessAt: null,
  lastError: null,
}

export interface PingResponse {
  readonly uptime: number
  readonly pid: number
  readonly controlPlane: ControlPlaneStatusSnapshot
}

export interface ShutdownResponse {
  readonly ok: true
}

export interface ChatEventSseMessage {
  readonly type: 'chat.event'
  readonly event: DomainEventEnvelope
}

export interface ChatDoneSseMessage {
  readonly type: 'chat.done'
}

export interface ChatErrorSseMessage {
  readonly type: 'chat.error'
  readonly code: 'ACTIVE_SESSION_CONCURRENCY_UNSUPPORTED' | 'INTERNAL' | 'SESSION_NOT_FOUND'
  readonly message: string
}

export type ChatSseMessage = ChatEventSseMessage | ChatDoneSseMessage | ChatErrorSseMessage

/**
 * Encodes a typed SSE message into the standard `event: ...\ndata: ...\n\n` wire format.
 */
export function encodeSseMessage(input: {
  event: string
  data: ChatSseMessage
}): string {
  return `event: ${input.event}\ndata: ${JSON.stringify(input.data)}\n\n`
}
