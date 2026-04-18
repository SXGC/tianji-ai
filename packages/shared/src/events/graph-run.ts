/**
 * GraphRun 聚合领域事件。
 * @module events/graph-run
 */

import type { TianjiError } from '../errors.js'
import type { RunId } from '../identifiers.js'
import type { TokenUsage } from '../snapshot.js'

export type GraphNodeKind = 'agent' | 'acp-agent' | 'human-gate' | 'fork'

interface GraphRunFields {
  readonly runId: RunId
  readonly graphId: string
  readonly graphVersion: number
  readonly timestamp: number
}

export interface GraphRunStartedEvent extends GraphRunFields {
  readonly type: 'GraphRunStarted'
  readonly mermaidDiagram: string
}

export interface GraphRunCompletedEvent extends GraphRunFields {
  readonly type: 'GraphRunCompleted'
  readonly finalState: Record<string, unknown>
  readonly usage?: TokenUsage
}

export interface GraphRunFailedEvent extends GraphRunFields {
  readonly type: 'GraphRunFailed'
  readonly error: TianjiError
  readonly usage?: TokenUsage
}

/**
 * Graph 因外部 AbortSignal 取消而终止。
 * 语义上与 `GraphRunFailed` 区分：`reason` 标识触发源；当前仅 'abort'。
 */
export interface GraphRunCancelledEvent extends GraphRunFields {
  readonly type: 'GraphRunCancelled'
  readonly reason: 'abort'
  readonly usage?: TokenUsage
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
  readonly usage?: TokenUsage
}

export interface GraphNodeFailedEvent extends GraphNodeFields {
  readonly type: 'GraphNodeFailed'
  readonly error: TianjiError
  readonly usage?: TokenUsage
}

export type GraphRunDomainEvent =
  | GraphRunStartedEvent
  | GraphRunCompletedEvent
  | GraphRunFailedEvent
  | GraphRunCancelledEvent
  | GraphNodeStartedEvent
  | GraphNodeCompletedEvent
  | GraphNodeFailedEvent
