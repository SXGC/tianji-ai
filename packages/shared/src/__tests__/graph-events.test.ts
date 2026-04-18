import { describe, expectTypeOf, it } from 'vitest'

import type {
  GraphNodeCompletedEvent,
  GraphNodeFailedEvent,
  GraphRunCancelledEvent,
  GraphRunCompletedEvent,
  GraphRunFailedEvent,
} from '../events/graph-run.js'
import type { RunId } from '../identifiers.js'
import type { TokenUsage } from '../snapshot.js'

describe('graph event contracts', () => {
  it('allows usage on graph node completion while preserving output', () => {
    const event: GraphNodeCompletedEvent = {
      type: 'GraphNodeCompleted',
      runId: 'run-1' as RunId,
      graphId: 'graph-1',
      nodeId: 'node-1',
      nodeKind: 'agent',
      timestamp: 0,
      output: { answer: 'ok' },
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    } satisfies GraphNodeCompletedEvent

    expectTypeOf(event.output).toEqualTypeOf<Record<string, unknown>>()
    expectTypeOf(event.usage).toEqualTypeOf<TokenUsage | undefined>()
  })

  it('allows usage on graph run completion and failure events', () => {
    const completedEvent: GraphRunCompletedEvent = {
      type: 'GraphRunCompleted',
      runId: 'run-1' as RunId,
      graphId: 'graph-1',
      graphVersion: 1,
      timestamp: 0,
      finalState: {},
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    }

    const failedEvent: GraphRunFailedEvent = {
      type: 'GraphRunFailed',
      runId: 'run-1' as RunId,
      graphId: 'graph-1',
      graphVersion: 1,
      timestamp: 0,
      error: { name: 'Error', message: 'boom' } as never,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    }

    const cancelledEvent: GraphRunCancelledEvent = {
      type: 'GraphRunCancelled',
      runId: 'run-1' as RunId,
      graphId: 'graph-1',
      graphVersion: 1,
      timestamp: 0,
      reason: 'abort',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    }

    expectTypeOf(completedEvent.usage).toEqualTypeOf<TokenUsage | undefined>()
    expectTypeOf(failedEvent.usage).toEqualTypeOf<TokenUsage | undefined>()
    expectTypeOf(cancelledEvent.usage).toEqualTypeOf<TokenUsage | undefined>()
  })

  it('allows usage on graph node failure events', () => {
    const event: GraphNodeFailedEvent = {
      type: 'GraphNodeFailed',
      runId: 'run-1' as RunId,
      graphId: 'graph-1',
      nodeId: 'node-1',
      nodeKind: 'agent',
      timestamp: 0,
      error: { name: 'Error', message: 'boom' } as never,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    }

    expectTypeOf(event.usage).toEqualTypeOf<TokenUsage | undefined>()
  })
})
