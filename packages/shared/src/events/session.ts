/**
 * Session 聚合领域事件。
 * @module events/session
 */

import type { SessionId } from '../identifiers.js'

interface SessionFields {
  readonly sessionId: SessionId
  readonly timestamp: number
}

export interface SessionCreatedEvent extends SessionFields {
  readonly type: 'SessionCreated'
}

export interface SessionResumedEvent extends SessionFields {
  readonly type: 'SessionResumed'
  readonly checkpointId: string
}

export interface SessionClosedEvent extends SessionFields {
  readonly type: 'SessionClosed'
}

export type SessionDomainEvent = SessionCreatedEvent | SessionResumedEvent | SessionClosedEvent
