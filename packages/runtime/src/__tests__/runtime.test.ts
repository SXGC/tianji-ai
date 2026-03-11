import { type AppMessage, createSessionId } from '@tianji/contracts'
import type { LlmResponse } from '@tianji/llm'
import { describe, expect, it } from 'vitest'

import { createSessionRuntime } from '../runtime.js'
import { InMemorySnapshotStore } from '../snapshot-store.js'
import { ToolRegistry } from '../tool-catalog.js'

describe('SessionRuntime', () => {
  it('creates a session and runs a streamed turn', async () => {
    const callbacks: Array<
      (
        event:
          | { type: 'delta'; payload: { delta: string; isFinal: boolean } }
          | { type: 'complete'; payload: { response: LlmResponse } }
          | { type: 'error'; payload: { message: string; code?: string } }
      ) => void
    > = []
    const runtime = createSessionRuntime({
      llmGateway: {
        stream: async () => ({
          onEvent: (callback) => {
            callbacks.push(callback)
          },
          abort: () => {},
          waitUntilComplete: async () => {
            for (const callback of callbacks) {
              callback({ type: 'delta', payload: { delta: 'hello', isFinal: false } })
              callback({ type: 'delta', payload: { delta: '', isFinal: true } })
            }

            return {
              content: 'hello',
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
              toolCalls: [],
              toolResults: [],
            }
          },
        }),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry(),
    })

    const session = await runtime.createSession({ sessionId: createSessionId('session-runtime') })
    const userMessage: AppMessage = {
      id: 'msg-user',
      role: 'user',
      content: [{ type: 'text', text: 'say hello' }],
      createdAt: 1,
    }

    const runId = await runtime.runTurn({ sessionId: session.sessionId, message: userMessage })
    const events: string[] = []

    for await (const event of runtime.streamEvents(runId)) {
      events.push(event.type)
    }

    expect(events).toEqual([
      'run.started',
      'message.started',
      'message.delta',
      'message.completed',
      'run.completed',
    ])
  })
})
