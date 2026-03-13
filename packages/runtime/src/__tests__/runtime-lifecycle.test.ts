import {
  type AppMessage,
  type RunId,
  type RunSnapshot,
  type RuntimeEvent,
  createRunId,
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

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined
  let reject: ((reason?: unknown) => void) | undefined
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  if (resolve === undefined || reject === undefined) {
    throw new Error('Failed to create deferred promise')
  }

  return { promise, resolve, reject }
}

function createAbortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function createMockResponse(content: string): LlmResponse {
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
    toolCalls: [],
    toolResults: [],
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
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []

  for await (const event of runtime.streamEvents(runId)) {
    events.push(event)
  }

  return events
}

function createUserMessage(id: string, text: string): AppMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    createdAt: 1,
  }
}

describe('SessionRuntime lifecycle', () => {
  it('resumes cancelled runs with stored prompt/config and tracks the source run id', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const requestSeen = createDeferred<LlmRequest>()
    const runtime = createSessionRuntime({
      llmGateway: createMockGateway(async (request, emit) => {
        requestSeen.resolve(request)
        emit({ type: 'delta', payload: { delta: 'resumed answer', isFinal: false } })
        emit({ type: 'delta', payload: { delta: '', isFinal: true } })

        return createMockResponse('resumed answer')
      }),
      snapshotStore,
      toolCatalog: new ToolRegistry(),
      defaultSystemPrompt: 'default prompt',
      defaultGenerationConfig: { temperature: 0.1, maxTokens: 8 },
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-resume'),
      messages: [createUserMessage('msg-resume-user', 'resume this run')],
    })
    const cancelledRunId = createRunId('run-resume-source')
    const storedConfig = { temperature: 0.7, maxTokens: 42 }
    const previousRun: RunSnapshot = {
      runId: cancelledRunId,
      sessionId: session.sessionId,
      status: 'cancelled',
      messages: session.messages,
      createdAt: 1,
      updatedAt: 1,
      pendingOperations: [],
      metadata: {
        systemPrompt: 'stored prompt',
        generationConfig: storedConfig,
      },
    }

    await snapshotStore.saveRun(previousRun)

    const resumedRunId = await runtime.resumeRun({ runId: cancelledRunId })
    const events = await collectRuntimeEvents(resumedRunId, runtime)
    const resumedRequest = await requestSeen.promise
    const resumedRun = await runtime.getRunSnapshot(resumedRunId)

    expect(resumedRequest.messages).toEqual(previousRun.messages)
    expect(resumedRequest.systemPrompt).toBe('stored prompt')
    expect(resumedRequest.config).toEqual(storedConfig)
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.started',
      'message.delta',
      'message.completed',
      'run.completed',
    ])
    expect(resumedRun?.metadata).toMatchObject({
      systemPrompt: 'stored prompt',
      generationConfig: storedConfig,
      resumedFromRunId: cancelledRunId,
    })
  })

  it('rejects resuming runs that are not cancelled', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      llmGateway: createMockGateway(async () => createMockResponse('unused')),
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })
    const session = await runtime.createSession({
      sessionId: createSessionId('session-resume-invalid'),
      messages: [createUserMessage('msg-resume-invalid', 'resume invalid run')],
    })
    const completedRunId = createRunId('run-completed-source')

    await snapshotStore.saveRun({
      runId: completedRunId,
      sessionId: session.sessionId,
      status: 'completed',
      messages: session.messages,
      createdAt: 1,
      updatedAt: 1,
      pendingOperations: [],
    })

    await expect(runtime.resumeRun({ runId: completedRunId })).rejects.toMatchObject({
      code: 'RUN_NOT_CANCELLABLE',
    })
  })

  it('closes sessions by persisting closedAt, aborting active runs, and blocking future work', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const requestSeen = createDeferred<LlmRequest>()
    const runtime = createSessionRuntime({
      llmGateway: createMockGateway(async (request) => {
        requestSeen.resolve(request)

        await new Promise<never>((_resolve, reject) => {
          request.abortSignal?.addEventListener(
            'abort',
            () => {
              reject(createAbortError('session closed'))
            },
            { once: true }
          )
        })

        throw new Error('Unreachable')
      }),
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-close'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-close-user', 'close this session'),
    })
    const eventsPromise = collectRuntimeEvents(runId, runtime)

    const activeRequest = await requestSeen.promise
    const closedSession = await runtime.closeSession(session.sessionId)
    const events = await eventsPromise
    const cancelledRun = await runtime.getRunSnapshot(runId)

    expect(closedSession.metadata?.closedAt).toEqual(expect.any(Number))
    expect(activeRequest.abortSignal?.aborted).toBe(true)
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.started',
      'run.cancelled',
    ])
    expect(cancelledRun?.status).toBe('cancelled')
    await expect(
      runtime.runTurn({
        sessionId: session.sessionId,
        message: createUserMessage('msg-close-next', 'try again'),
      })
    ).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(runtime.resumeRun({ runId })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })
})
