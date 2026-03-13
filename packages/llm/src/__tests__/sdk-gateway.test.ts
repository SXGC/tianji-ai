import { createRunId } from '@tianji/contracts'
import type { LanguageModelV1 } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LlmProvider, LlmProviderConfig, LlmRequest, LlmStreamEvent } from '../index.js'
import { SdkLlmGateway } from '../sdk-gateway.js'

interface MockToolDefinition {
  readonly execute?: (args: unknown, options: MockToolExecutionOptions) => Promise<unknown>
}

interface MockToolExecutionOptions {
  readonly toolCallId: string
  readonly abortSignal?: AbortSignal
}

interface MockCallOptions {
  readonly abortSignal?: AbortSignal
  readonly headers?: Record<string, string>
  readonly maxSteps?: number
  readonly providerOptions?: Record<string, Record<string, unknown>>
  readonly tools?: Record<string, MockToolDefinition>
}

interface MockGenerateResult {
  readonly text: string
  readonly usage: {
    readonly promptTokens: number
    readonly completionTokens: number
    readonly totalTokens: number
  }
  readonly finishReason: string
  readonly response: {
    readonly id: string
    readonly modelId: string
  }
  readonly toolCalls: readonly unknown[]
  readonly toolResults: readonly unknown[]
}

interface MockStreamResult {
  readonly fullStream: AsyncIterable<{ readonly type: string; readonly textDelta?: string }>
  readonly text: Promise<string>
  readonly usage: Promise<{
    readonly promptTokens: number
    readonly completionTokens: number
    readonly totalTokens: number
  }>
  readonly finishReason: Promise<string>
  readonly response: Promise<{
    readonly id: string
    readonly modelId: string
  }>
  readonly toolCalls: Promise<readonly unknown[]>
  readonly toolResults: Promise<readonly unknown[]>
}

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
  tool: vi.fn((definition: unknown) => definition),
}))

vi.mock('ai', () => ({
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  tool: aiMocks.tool,
}))

function createGateway(
  provider: LlmProvider = 'openai',
  overrides: Partial<LlmProviderConfig> = {}
): SdkLlmGateway {
  const config: LlmProviderConfig = {
    provider,
    model: 'test-model',
    apiKey: 'test-key',
    ...overrides,
  }

  return new SdkLlmGateway(config, provider, () => ({}) as LanguageModelV1)
}

function createRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    runId: createRunId('run-sdk-gateway'),
    messages: [
      {
        id: 'msg-user',
        role: 'user',
        content: [{ type: 'text', text: 'hello gateway' }],
        createdAt: 1,
      },
    ],
    ...overrides,
  }
}

function createGenerateResult(overrides: Partial<MockGenerateResult> = {}): MockGenerateResult {
  return {
    text: 'hello gateway',
    usage: {
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
    },
    finishReason: 'stop',
    response: {
      id: 'req-1',
      modelId: 'provider-model',
    },
    toolCalls: [],
    toolResults: [],
    ...overrides,
  }
}

function createFailingStream(
  error: Error
): AsyncIterable<{ readonly type: string; readonly textDelta?: string }> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<{
      readonly type: string
      readonly textDelta?: string
    }> {
      return {
        next: async () => {
          throw error
        },
      }
    },
  }
}

async function* createTextStream(...deltas: readonly string[]) {
  for (const delta of deltas) {
    yield {
      type: 'text-delta',
      textDelta: delta,
    }
  }
}

function readGenerateCallOptions(): MockCallOptions {
  const call = aiMocks.generateText.mock.calls[0]?.[0]

  if (call === undefined) {
    throw new Error('Expected generateText to be called')
  }

  return call as MockCallOptions
}

function readStreamCallOptions(): MockCallOptions {
  const call = aiMocks.streamText.mock.calls[0]?.[0]

  if (call === undefined) {
    throw new Error('Expected streamText to be called')
  }

  return call as MockCallOptions
}

describe('SdkLlmGateway', () => {
  beforeEach(() => {
    aiMocks.generateText.mockReset()
    aiMocks.streamText.mockReset()
    aiMocks.tool.mockClear()
  })

  it('bridges tool calling through generate and maps the final response', async () => {
    const gateway = createGateway('openai', {
      options: { reasoningEffort: 'medium' },
    })
    const executeTool = vi.fn(
      async (_toolName: string, _args: unknown, options: MockToolExecutionOptions) => ({
        ok: true,
        toolCallId: options.toolCallId,
        aborted: options.abortSignal?.aborted ?? false,
      })
    )

    aiMocks.generateText.mockResolvedValue(
      createGenerateResult({
        text: 'tool result ready',
        toolCalls: [
          {
            toolCallId: 'tool-1',
            toolName: 'lookup',
            args: { city: 'Shanghai' },
          },
        ],
        toolResults: [{ toolCallId: 'tool-1', result: { city: 'Shanghai', ok: true } }],
      })
    )

    const response = await gateway.generate(
      createRequest({
        config: { maxTokens: 32 },
        headers: { 'x-trace-id': 'trace-1' },
        tools: [
          {
            name: 'lookup',
            description: 'Look up a city',
            parameters: { type: 'object' },
          },
        ],
        executeTool,
      })
    )

    const callOptions = readGenerateCallOptions()
    const bridgedTool = callOptions.tools?.lookup
    const bridgedAbortController = new AbortController()
    bridgedAbortController.abort()

    expect(callOptions.headers).toEqual({ 'x-trace-id': 'trace-1' })
    expect(callOptions.providerOptions).toEqual({
      openai: { reasoningEffort: 'medium' },
    })
    expect(callOptions.maxSteps).toBe(2)
    expect(bridgedTool).toBeDefined()
    await expect(
      bridgedTool?.execute?.(
        { city: 'Shanghai' },
        {
          toolCallId: 'tool-1',
          abortSignal: bridgedAbortController.signal,
        }
      )
    ).resolves.toEqual({
      ok: true,
      toolCallId: 'tool-1',
      aborted: true,
    })
    expect(executeTool).toHaveBeenCalledWith(
      'lookup',
      { city: 'Shanghai' },
      {
        toolCallId: 'tool-1',
        abortSignal: bridgedAbortController.signal,
      }
    )

    expect(response).toMatchObject({
      content: 'tool result ready',
      finishReason: 'stop',
      meta: {
        provider: 'openai',
        model: 'provider-model',
        requestId: 'req-1',
      },
      toolCalls: [{ toolCallId: 'tool-1', toolName: 'lookup', args: { city: 'Shanghai' } }],
      toolResults: [{ toolCallId: 'tool-1', result: { city: 'Shanghai', ok: true } }],
      usage: {
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12,
      },
    })
  })

  it('streams deltas in order, completes with the mapped response, and supports abort', async () => {
    const gateway = createGateway('anthropic')

    aiMocks.streamText.mockReturnValue({
      fullStream: createTextStream('hel', 'lo'),
      text: Promise.resolve('hello'),
      usage: Promise.resolve({
        promptTokens: 3,
        completionTokens: 2,
        totalTokens: 5,
      }),
      finishReason: Promise.resolve('stop'),
      response: Promise.resolve({ id: 'req-stream', modelId: 'claude-test' }),
      toolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
    } satisfies MockStreamResult)

    const stream = await gateway.stream(createRequest())
    const events: LlmStreamEvent[] = []

    stream.onEvent((event) => {
      events.push(event)
    })

    const response = await stream.waitUntilComplete()
    const callOptions = readStreamCallOptions()

    expect(callOptions.maxSteps).toBe(1)
    expect(callOptions.abortSignal?.aborted).toBe(false)
    stream.abort()
    expect(callOptions.abortSignal?.aborted).toBe(true)

    expect(events).toEqual([
      { type: 'delta', payload: { delta: 'hel', isFinal: false } },
      { type: 'delta', payload: { delta: 'lo', isFinal: false } },
      { type: 'delta', payload: { delta: '', isFinal: true } },
      {
        type: 'complete',
        payload: {
          response,
        },
      },
    ])
    expect(response).toMatchObject({
      content: 'hello',
      meta: {
        provider: 'anthropic',
        model: 'claude-test',
        requestId: 'req-stream',
      },
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
      },
    })
  })

  it('emits an error event when the underlying stream fails', async () => {
    const gateway = createGateway('google')
    const streamError = new Error('stream exploded')
    const events: LlmStreamEvent[] = []

    aiMocks.streamText.mockReturnValue({
      fullStream: createFailingStream(streamError),
      text: Promise.resolve(''),
      usage: Promise.resolve({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      }),
      finishReason: Promise.resolve('error'),
      response: Promise.resolve({ id: 'req-error', modelId: 'gemini-test' }),
      toolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
    } satisfies MockStreamResult)

    const stream = await gateway.stream(createRequest())
    stream.onEvent((event) => {
      events.push(event)
    })

    await expect(stream.waitUntilComplete()).rejects.toThrow('stream exploded')
    expect(events).toEqual([
      {
        type: 'error',
        payload: {
          message: 'stream exploded',
          code: 'Error',
        },
      },
    ])
  })
})
