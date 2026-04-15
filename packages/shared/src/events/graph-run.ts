/**
 * GraphRun 聚合领域事件。
 * @module events/graph-run
 */

import type { TianjiError } from '../errors.js'
import type { RunId } from '../identifiers.js'

export type GraphNodeKind = 'agent' | 'acp-agent' | 'human-gate' | 'fork'

interface GraphRunFields {
  readonly runId: RunId
  readonly graphId: string
  readonly graphVersion: number
  readonly timestamp: number
}

export interface GraphRunStartedEvent extends GraphRunFields {
  readonly type: 'GraphRunStarted'
}

export interface GraphRunCompletedEvent extends GraphRunFields {
  readonly type: 'GraphRunCompleted'
  readonly finalState: Record<string, unknown>
}

export interface GraphRunFailedEvent extends GraphRunFields {
  readonly type: 'GraphRunFailed'
  readonly error: TianjiError
}

interface GraphNodeFields {
  readonly runId: RunId
  readonly graphId: string
  readonly nodeId: string
  readonly nodeKind: GraphNodeKind
  readonly timestamp: number
}

export interface GraphNodeStartedEvent extends GraphNodeFields {
  readonly type: 'GraphNodeStarted'
}

export interface GraphNodeCompletedEvent extends GraphNodeFields {
  readonly type: 'GraphNodeCompleted'
  readonly output: Record<string, unknown>
}

export interface GraphNodeFailedEvent extends GraphNodeFields {
  readonly type: 'GraphNodeFailed'
  readonly error: TianjiError
}

export type GraphRunDomainEvent =
  | GraphRunStartedEvent
  | GraphRunCompletedEvent
  | GraphRunFailedEvent
  | GraphNodeStartedEvent
  | GraphNodeCompletedEvent
  | GraphNodeFailedEvent
