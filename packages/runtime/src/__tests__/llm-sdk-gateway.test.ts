import { ProviderError, TianjiError, createRunId } from '@tianji/shared'
import type { LanguageModelV1 } from 'ai'
import { describe, expect, it, vi } from 'vitest'

import type { LlmProviderConfig, LlmRequest, LlmStreamEvent } from '../llm/index.js'
import { SdkLlmGateway } from '../llm/sdk-gateway.js'

// ---------------------------------------------------------------------------
// Mock ai module
// ---------------------------------------------------------------------------

vi.mock('ai', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    generateText: vi.fn(),
    streamText: vi.fn(),
  }
})

// Import mocked functions after vi.mock
const { generateText, streamText } = await import('ai')
const mockedGenerateText = vi.mocked(generateText)
const mockedStreamText = vi.mocked(streamText)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dummyModel = { modelId: 'test-model' } as unknown as LanguageModelV1
const dummyModelFactory = () => dummyModel

function makeConfig(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    provider: 'openai',
    model: 'gpt-4',
    ...overrides,
  }
}

function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    runId: createRunId('run-1'),
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        createdAt: Date.now(),
      },
    ],
    ...overrides,
  }
}

function makeSdkResult(text = 'Hello back') {
  return {
    text,
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finishReason: 'stop',
    response: { id: 'resp-1', modelId: 'gpt-4' },
    toolCalls: [],
    toolResults: [],
  }
}

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

describe('SdkLlmGateway.generate', () => {
  it('returns correct LlmResponse', async () => {
    mockedGenerateText.mockResolvedValue(makeSdkResult() as never)
    const gw = new SdkLlmGateway(makeConfig(), 'openai', dummyModelFactory)

    const response = await gw.generate(makeRequest())

    expect(response.content).toBe('Hello back')
    expect(response.finishReason).toBe('stop')
    expect(response.meta.provider).toBe('openai')
    expect(response.meta.model).toBe('gpt-4')
    expect(response.usage.inputTokens).toBe(10)
    expect(response.usage.outputTokens).toBe(5)
  })

  it('wraps unknown errors in ProviderError', async () => {
    mockedGenerateText.mockRejectedValue(new Error('network down'))
    const gw = new SdkLlmGateway(makeConfig(), 'openai', dummyModelFactory)

    await expect(gw.generate(makeRequest())).rejects.toThrow(ProviderError)
    await expect(gw.generate(makeRequest())).rejects.toThrow('network down')
  })

  it('re-throws ProviderError as-is', async () => {
    const original = new ProviderError('RATE_LIMIT', 'Too many requests')
    mockedGenerateText.mockRejectedValue(original)
    const gw = new SdkLlmGateway(makeConfig(), 'openai', dummyModelFactory)

    await expect(gw.generate(makeRequest())).rejects.toBe(original)
  })

  it('re-throws TianjiError as-is', async () => {
    const original = new TianjiError('internal', 'INTERNAL', 'something broke')
    mockedGenerateText.mockRejectedValue(original)
    const gw = new SdkLlmGateway(makeConfig(), 'openai', dummyModelFactory)

    await expect(gw.generate(makeRequest())).rejects.toBe(original)
  })
})

// ---------------------------------------------------------------------------
// stream
// ---------------------------------------------------------------------------

describe('SdkLlmGateway.stream', () => {
  it('emits delta events and complete event', async () => {
    const chunks = [
      { type: 'text-delta', textDelta: 'Hi' },
      { type: 'text-delta', textDelta: ' there' },
    ]

    async function* asyncChunks() {
      for (const chunk of chunks) {
        yield chunk
      }
    }

    mockedStreamText.mockReturnValue({
      fullStream: asyncChunks(),
      text: Promise.resolve('Hi there'),
      usage: Promise.resolve({ promptTokens: 5, completionTokens: 3, totalTokens: 8 }),
      finishReason: Promise.resolve('stop'),
      response: Promise.resolve({ id: 'resp-s1', modelId: 'gpt-4' }),
      toolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
    } as never)

    const gw = new SdkLlmGateway(makeConfig(), 'openai', dummyModelFactory)
    const stream = await gw.stream(makeRequest())

    const events: LlmStreamEvent[] = []
    stream.onEvent((e) => events.push(e))

    const response = await stream.waitUntilComplete()

    expect(response.content).toBe('Hi there')

    const deltas = events.filter((e) => e.type === 'delta')
    // At least 2 text deltas + 1 final delta
    expect(deltas.length).toBeGreaterThanOrEqual(3)

    const completeEvents = events.filter((e) => e.type === 'complete')
    expect(completeEvents).toHaveLength(1)
  })

  it('emits error event on failure', async () => {
    async function* failingStream(): AsyncGenerator<{ type: string; textDelta?: string }> {
      yield { type: 'text-delta', textDelta: 'partial' }
      throw new Error('stream broke')
    }

    // Create rejected promises and suppress unhandled rejection warnings
    const rejected = <T>(): Promise<T> => {
      const p = Promise.reject(new Error('stream broke')) as Promise<T>
      p.catch(() => {})
      return p
    }

    mockedStreamText.mockReturnValue({
      fullStream: failingStream(),
      text: rejected<string>(),
      usage: rejected(),
      finishReason: rejected<string>(),
      response: rejected(),
      toolCalls: rejected(),
      toolResults: rejected(),
    } as never)

    const gw = new SdkLlmGateway(makeConfig(), 'openai', dummyModelFactory)
    const stream = await gw.stream(makeRequest())

    const events: LlmStreamEvent[] = []
    stream.onEvent((e) => events.push(e))

    await expect(stream.waitUntilComplete()).rejects.toThrow('stream broke')

    const errorEvents = events.filter((e) => e.type === 'error')
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0].type === 'error' && errorEvents[0].payload.message).toBe('stream broke')
  })

  it('abort() can be called', async () => {
    async function* emptyStream(): AsyncGenerator<{ type: string; textDelta?: string }> {
      // empty
    }

    mockedStreamText.mockReturnValue({
      fullStream: emptyStream(),
      text: Promise.resolve(''),
      usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
      finishReason: Promise.resolve('stop'),
      response: Promise.resolve({ id: 'resp-a', modelId: 'gpt-4' }),
      toolCalls: Promise.resolve([]),
      toolResults: Promise.resolve([]),
    } as never)

    const gw = new SdkLlmGateway(makeConfig(), 'openai', dummyModelFactory)
    const stream = await gw.stream(makeRequest())

    // abort() should not throw
    expect(() => stream.abort()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// isReady
// ---------------------------------------------------------------------------

describe('SdkLlmGateway.isReady', () => {
  it('returns true with apiKey', () => {
    const gw = new SdkLlmGateway(makeConfig({ apiKey: 'sk-test' }), 'openai', dummyModelFactory)
    expect(gw.isReady()).toBe(true)
  })

  it('returns true with baseUrl', () => {
    const gw = new SdkLlmGateway(
      makeConfig({ baseUrl: 'https://proxy.example.com' }),
      'openai',
      dummyModelFactory
    )
    expect(gw.isReady()).toBe(true)
  })

  it('returns true with headers', () => {
    const gw = new SdkLlmGateway(
      makeConfig({ headers: { 'x-api-key': 'abc' } }),
      'openai',
      dummyModelFactory
    )
    expect(gw.isReady()).toBe(true)
  })

  it('returns true when env var is set', () => {
    const original = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-env'
    try {
      const gw = new SdkLlmGateway(makeConfig(), 'openai', dummyModelFactory)
      expect(gw.isReady()).toBe(true)
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(process.env, 'OPENAI_API_KEY')
      } else {
        process.env.OPENAI_API_KEY = original
      }
    }
  })

  it('returns false when nothing configured', () => {
    const original = process.env.ANTHROPIC_API_KEY
    Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY')
    try {
      const gw = new SdkLlmGateway(
        makeConfig({ provider: 'anthropic' }),
        'anthropic',
        dummyModelFactory
      )
      expect(gw.isReady()).toBe(false)
    } finally {
      if (original !== undefined) {
        process.env.ANTHROPIC_API_KEY = original
      }
    }
  })
})

// ---------------------------------------------------------------------------
// getProviderInfo
// ---------------------------------------------------------------------------

describe('SdkLlmGateway.getProviderInfo', () => {
  it('returns provider and model', () => {
    const gw = new SdkLlmGateway(makeConfig({ model: 'gpt-4o' }), 'openai', dummyModelFactory)
    const info = gw.getProviderInfo()

    expect(info.provider).toBe('openai')
    expect(info.model).toBe('gpt-4o')
  })
})

// ---------------------------------------------------------------------------
// buildTools (tested indirectly via generate)
// ---------------------------------------------------------------------------

describe('SdkLlmGateway buildTools behavior', () => {
  it('passes undefined tools when request has no tools', async () => {
    mockedGenerateText.mockResolvedValue(makeSdkResult() as never)
    const gw = new SdkLlmGateway(makeConfig(), 'openai', dummyModelFactory)

    await gw.generate(makeRequest({ tools: undefined }))

    const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs.tools).toBeUndefined()
  })

  it('passes undefined tools for empty tools array', async () => {
    mockedGenerateText.mockResolvedValue(makeSdkResult() as never)
    const gw = new SdkLlmGateway(makeConfig(), 'openai', dummyModelFactory)

    await gw.generate(makeRequest({ tools: [] }))

    const callArgs = mockedGenerateText.mock.calls[0][0] as Record<string, unknown>
    expect(callArgs.tools).toBeUndefined()
  })

  it('creates tool entries with execute when executeTool is provided', async () => {
    mockedGenerateText.mockResolvedValue(makeSdkResult() as never)
    const callCountBefore = mockedGenerateText.mock.calls.length
    const gw = new SdkLlmGateway(makeConfig(), 'openai', dummyModelFactory)

    const executeTool = vi.fn().mockResolvedValue('result')
    await gw.generate(
      makeRequest({
        tools: [
          {
            name: 'my_tool',
            description: 'A tool',
            parameters: { type: 'object', properties: {} },
          },
        ],
        executeTool,
      })
    )

    const callArgs = mockedGenerateText.mock.calls[callCountBefore][0] as Record<string, unknown>
    expect(callArgs.tools).toBeDefined()
    expect(callArgs.tools).toHaveProperty('my_tool')
  })
})
