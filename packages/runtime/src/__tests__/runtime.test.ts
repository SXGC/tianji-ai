import {
  type AggregatedMessageDeltaState,
  type AppMessage,
  type RunId,
  type RuntimeEvent,
  applyMessageDelta,
  createSessionId,
} from '@tianji/contracts'
import type { LlmRequest, LlmResponse } from '@tianji/llm'
import { describe, expect, it } from 'vitest'

import { createSessionRuntime } from '../runtime.js'
import { InMemorySnapshotStore } from '../snapshot-store.js'
import { ToolRegistry } from '../tool-catalog.js'

type MockStreamEvent =
  | { type: 'delta'; payload: { delta: string; isFinal: boolean } }
  | { type: 'complete'; payload: { response: LlmResponse } }
  | { type: 'error'; payload: { message: string; code?: string } }

type MockGatewayHandler = (
  request: LlmRequest,
  emit: (event: MockStreamEvent) => void
) => Promise<LlmResponse>

function createMockResponse(
  content: string,
  overrides: Partial<Pick<LlmResponse, 'toolCalls' | 'toolResults'>> = {}
): LlmResponse {
  return {
    content,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cost: {
        currency: 'USD',
        inputCost: 0,
        outputCost: 0,
        totalCost: 0,
        pricingSource: 'unavailable',
      },
    },
    meta: { provider: 'openai', model: 'fake' },
    finishReason: 'stop',
    toolCalls: overrides.toolCalls ?? [],
    toolResults: overrides.toolResults ?? [],
  }
}

function createMockGateway(handler: MockGatewayHandler) {
  return {
    stream: async (request: LlmRequest) => {
      const callbacks = new Set<(event: MockStreamEvent) => void>()

      return {
        onEvent: (callback: (event: MockStreamEvent) => void) => {
          callbacks.add(callback)
        },
        abort: () => {},
        waitUntilComplete: async () =>
          handler(request, (event) => {
            for (const callback of callbacks) {
              callback(event)
            }
          }),
      }
    },
  }
}

async function collectRuntimeEvents(
  runId: RunId,
  runtime: ReturnType<typeof createSessionRuntime>
) {
  const events: RuntimeEvent[] = []

  for await (const event of runtime.streamEvents(runId)) {
    events.push(event)
  }

  return events
}

async function collectRuntimeEventsWithAggregation(
  runId: RunId,
  runtime: ReturnType<typeof createSessionRuntime>
) {
  const events: RuntimeEvent[] = []
  let aggregatedAssistantMessage: AggregatedMessageDeltaState | undefined

  for await (const event of runtime.streamEvents(runId)) {
    events.push(event)

    if (event.type !== 'message.delta') {
      continue
    }

    aggregatedAssistantMessage = applyMessageDelta(aggregatedAssistantMessage, {
      runId: event.runId,
      messageId: event.messageId,
      sequence: event.sequence,
      op: 'append',
      channel: event.channel,
      payload: event.payload.content,
      timestamp: event.timestamp,
    })
  }

  return {
    events,
    aggregatedAssistantMessage,
  }
}

function readTextContent(message: AppMessage): string {
  return message.content
    .filter(
      (part): part is Extract<AppMessage['content'][number], { type: 'text' }> =>
        part.type === 'text'
    )
    .map((part) => part.text)
    .join('')
}

describe('SessionRuntime', () => {
  it('runs a single-turn conversation end to end and persists tool execution state', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolRegistry = new ToolRegistry().registerTool({
      spec: {
        name: 'sum',
        description: 'Add two numbers',
        parameters: { type: 'object' },
      },
      execute: async (args) => {
        if (typeof args !== 'object' || args === null) {
          throw new Error('Expected sum args to be an object')
        }

        const candidate = args as { a?: unknown; b?: unknown }
        if (typeof candidate.a !== 'number' || typeof candidate.b !== 'number') {
          throw new Error('Expected numeric sum args')
        }

        return candidate.a + candidate.b
      },
      sideEffect: 'idempotent',
    })

    const runtime = createSessionRuntime({
      llmGateway: createMockGateway(async (request, emit) => {
        emit({ type: 'delta', payload: { delta: 'Calculating ', isFinal: false } })
        const toolResult = await request.executeTool?.(
          'sum',
          { a: 1, b: 2 },
          { toolCallId: 'tool-1' }
        )
        emit({ type: 'delta', payload: { delta: `result ${toolResult}`, isFinal: false } })
        emit({ type: 'delta', payload: { delta: '', isFinal: true } })

        return createMockResponse('Calculating result 3', {
          toolCalls: [{ toolCallId: 'tool-1', toolName: 'sum', args: { a: 1, b: 2 } }],
          toolResults: [{ toolCallId: 'tool-1', result: toolResult }],
        })
      }),
      snapshotStore,
      toolCatalog: toolRegistry,
    })

    const session = await runtime.createSession({ sessionId: createSessionId('session-runtime') })
    const userMessage: AppMessage = {
      id: 'msg-user',
      role: 'user',
      content: [{ type: 'text', text: 'What is 1 + 2?' }],
      createdAt: 1,
    }

    const runId = await runtime.runTurn({ sessionId: session.sessionId, message: userMessage })
    const events = await collectRuntimeEvents(runId, runtime)

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.started',
      'message.delta',
      'tool.started',
      'tool.completed',
      'message.delta',
      'message.completed',
      'run.completed',
    ])

    const deltaEvents = events.filter(
      (event): event is Extract<RuntimeEvent, { type: 'message.delta' }> =>
        event.type === 'message.delta'
    )
    expect(deltaEvents.map((event) => event.payload.content)).toEqual(['Calculating ', 'result 3'])
    expect(deltaEvents.map((event) => event.sequence)).toEqual([1, 2])

    const toolStartedEvent = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'tool.started' }> =>
        event.type === 'tool.started'
    )
    expect(toolStartedEvent?.toolCallId).toBe('tool-1')
    expect(toolStartedEvent?.invocation.toolName).toBe('sum')

    const toolCompletedEvent = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'tool.completed' }> =>
        event.type === 'tool.completed'
    )
    expect(toolCompletedEvent?.toolCallId).toBe('tool-1')
    expect(toolCompletedEvent?.result.result).toBe(3)

    const runSnapshot = await runtime.getRunSnapshot(runId)
    expect(runSnapshot?.status).toBe('completed')
    expect(runSnapshot?.pendingOperations).toEqual([
      {
        id: 'tool-1',
        invocation: {
          toolCallId: 'tool-1',
          toolName: 'sum',
          args: { a: 1, b: 2 },
        },
        status: 'completed',
        timestamp: expect.any(Number),
      },
    ])

    const sessionSnapshot = await runtime.getSessionSnapshot(session.sessionId)
    expect(sessionSnapshot?.messages).toHaveLength(2)
    expect(readTextContent(sessionSnapshot?.messages[1] ?? userMessage)).toBe(
      'Calculating result 3'
    )
  })

  it('replays streamed deltas in order and stores the aggregated final assistant message', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      llmGateway: createMockGateway(async (_request, emit) => {
        emit({ type: 'delta', payload: { delta: 'hel', isFinal: false } })
        emit({ type: 'delta', payload: { delta: 'lo ', isFinal: false } })
        emit({ type: 'delta', payload: { delta: 'world', isFinal: false } })
        emit({ type: 'delta', payload: { delta: '', isFinal: true } })

        return createMockResponse('hello world')
      }),
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const session = await runtime.createSession({ sessionId: createSessionId('session-streaming') })
    const userMessage: AppMessage = {
      id: 'msg-streaming-user',
      role: 'user',
      content: [{ type: 'text', text: 'say hello world' }],
      createdAt: 1,
    }

    const runId = await runtime.runTurn({ sessionId: session.sessionId, message: userMessage })
    const { events, aggregatedAssistantMessage } = await collectRuntimeEventsWithAggregation(
      runId,
      runtime
    )
    const deltaEvents = events.filter(
      (event): event is Extract<RuntimeEvent, { type: 'message.delta' }> =>
        event.type === 'message.delta'
    )
    const completedEvent = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'message.completed' }> =>
        event.type === 'message.completed'
    )

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.started',
      'message.delta',
      'message.delta',
      'message.delta',
      'message.completed',
      'run.completed',
    ])
    expect(deltaEvents.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(deltaEvents.map((event) => event.payload.content)).toEqual(['hel', 'lo ', 'world'])
    expect(readTextContent(aggregatedAssistantMessage?.message ?? userMessage)).toBe('hello world')
    expect(readTextContent(completedEvent?.message ?? userMessage)).toBe('hello world')

    const runSnapshot = await runtime.getRunSnapshot(runId)
    expect(runSnapshot?.status).toBe('completed')
    expect(readTextContent(runSnapshot?.messages[1] ?? userMessage)).toBe('hello world')
  })
})
