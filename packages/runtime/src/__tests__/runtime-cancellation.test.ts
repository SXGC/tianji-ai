import {
  type AppMessage,
  DEFAULT_EXECUTION_POLICY,
  type RunId,
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

describe('SessionRuntime cancellation', () => {
  it('cancels active runs, aborts the llm signal, and emits run.cancelled', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const requestSeen = createDeferred<LlmRequest>()
    const runtime = createSessionRuntime({
      llmGateway: createMockGateway(async (request) => {
        requestSeen.resolve(request)

        await new Promise<never>((_resolve, reject) => {
          request.abortSignal?.addEventListener(
            'abort',
            () => {
              reject(createAbortError('run cancelled'))
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
      sessionId: createSessionId('session-cancel-llm'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-cancel-llm', 'cancel the llm stream'),
    })
    const eventsPromise = collectRuntimeEvents(runId, runtime)
    const activeRequest = await requestSeen.promise

    expect(runtime.cancelRun(createRunId('run-missing'))).toBe(false)
    expect(runtime.cancelRun(runId)).toBe(true)

    const events = await eventsPromise
    const cancelledRun = await runtime.getRunSnapshot(runId)

    expect(activeRequest.abortSignal?.aborted).toBe(true)
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.started',
      'run.cancelled',
    ])
    expect(cancelledRun?.status).toBe('cancelled')
    expect(runtime.cancelRun(runId)).toBe(false)
  })

  it('propagates abort signals into idempotent tools and keeps the run replayable', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const runtime = createSessionRuntime({
      llmGateway: createMockGateway(async (request) => {
        await request.executeTool?.('lookup', { city: 'Shanghai' }, { toolCallId: 'tool-clean' })
        return createMockResponse('unreachable')
      }),
      snapshotStore,
      toolCatalog: new ToolRegistry().registerTool({
        spec: {
          name: 'lookup',
          description: 'Look up data',
          parameters: { type: 'object' },
        },
        execute: async (_args, context) => {
          toolSignalSeen.resolve(context.abortSignal)

          await new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener(
              'abort',
              () => {
                reject(createAbortError('tool cancelled cleanly'))
              },
              { once: true }
            )
          })

          throw new Error('Unreachable')
        },
        sideEffect: 'idempotent',
      }),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-cancel-clean'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-cancel-clean', 'cancel the idempotent tool'),
    })
    const eventsPromise = collectRuntimeEvents(runId, runtime)
    const toolAbortSignal = await toolSignalSeen.promise

    expect(runtime.cancelRun(runId)).toBe(true)

    const events = await eventsPromise
    const cancelledRun = await runtime.getRunSnapshot(runId)

    expect(toolAbortSignal?.aborted).toBe(true)
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.started',
      'tool.started',
      'run.cancelled',
    ])
    expect(cancelledRun?.status).toBe('cancelled')
    expect(cancelledRun?.resumeHint).toBe('replay')
    expect(cancelledRun?.pendingOperations).toEqual([
      {
        id: 'tool-clean',
        invocation: {
          toolCallId: 'tool-clean',
          toolName: 'lookup',
          args: { city: 'Shanghai' },
        },
        status: 'aborted-clean',
        timestamp: expect.any(Number),
      },
    ])
  })

  it('marks destructive tools as requiring confirmation after cancellation', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const runtime = createSessionRuntime({
      llmGateway: createMockGateway(async (request) => {
        await request.executeTool?.(
          'delete-file',
          { path: '/tmp/test.txt' },
          { toolCallId: 'tool-danger' }
        )
        return createMockResponse('unreachable')
      }),
      snapshotStore,
      toolCatalog: new ToolRegistry().registerTool({
        spec: {
          name: 'delete-file',
          description: 'Delete a file',
          parameters: { type: 'object' },
        },
        execute: async (_args, context) => {
          toolSignalSeen.resolve(context.abortSignal)

          await new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener(
              'abort',
              () => {
                reject(createAbortError('destructive tool cancelled'))
              },
              { once: true }
            )
          })

          throw new Error('Unreachable')
        },
        sideEffect: 'destructive',
      }),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-cancel-danger'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-cancel-danger', 'cancel the destructive tool'),
      policy: {
        ...DEFAULT_EXECUTION_POLICY,
        tool: {
          ...DEFAULT_EXECUTION_POLICY.tool,
          allowDestructive: true,
        },
      },
    })
    const eventsPromise = collectRuntimeEvents(runId, runtime)
    const toolAbortSignal = await toolSignalSeen.promise

    expect(runtime.cancelRun(runId)).toBe(true)

    await eventsPromise
    const cancelledRun = await runtime.getRunSnapshot(runId)

    expect(toolAbortSignal?.aborted).toBe(true)
    expect(cancelledRun?.status).toBe('cancelled')
    expect(cancelledRun?.resumeHint).toBe('require-user-confirmation')
    expect(cancelledRun?.pendingOperations).toEqual([
      {
        id: 'tool-danger',
        invocation: {
          toolCallId: 'tool-danger',
          toolName: 'delete-file',
          args: { path: '/tmp/test.txt' },
        },
        status: 'aborted-with-side-effect',
        timestamp: expect.any(Number),
      },
    ])
  })
})
