/**
 * Delta types for tianji-ai
 *
 * Defines the contract for incremental updates during streaming.
 * Deltas represent small chunks of content that can be aggregated
 * into complete messages or tool results.
 *
 * @module delta
 */

import type { MessageDeltaChannel } from './events.js'
import type { RunId } from './identifiers.js'

export type DeltaOp = 'append' | 'replace' | 'complete'

export interface MessageDelta {
  readonly runId: RunId
  readonly messageId: string
  readonly sequence: number
  readonly op: DeltaOp
  readonly channel: MessageDeltaChannel
  readonly payload: unknown
  readonly timestamp: number
}

export type ToolProgressChannel = 'stdout' | 'stderr' | 'progress' | 'result'

export interface ToolProgressDelta {
  readonly runId: RunId
  readonly toolCallId: string
  readonly sequence: number
  readonly op: DeltaOp
  readonly channel: ToolProgressChannel
  readonly payload: unknown
  readonly timestamp: number
}

export type Delta = MessageDelta | ToolProgressDelta
