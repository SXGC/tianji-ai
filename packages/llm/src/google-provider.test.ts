import { ProviderError } from '@tianji/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GOOGLE_API_KEY_ENV,
  GOOGLE_DEFAULT_MODEL,
  createGoogleGateway,
  googleGateway,
} from './google-provider.js'
import type { LlmStreamEvent } from './types.js'

// Mock the 'ai' module
vi.mock('ai', () => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}))

// Mock @ai-sdk/google
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => {
    return (modelId: string) => ({
      modelId,
      provider: 'google.generative-ai',
      specificationVersion: 'v1',
    })
  }),
}))

import { generateText, streamText } from 'ai'

const mockGenerateText = vi.mocked(generateText)
const mockStreamText = vi.mocked(streamText)

describe('google-provider', () => {
  const originalEnv = process.env

  beforeEach(() => {
    vi.clearAllMocks()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('constants', () => {
    it('should export correct default model', () => {
      expect(GOOGLE_DEFAULT_MODEL).toBe('gemini-2.0-flash')
    })

    it('should export correct API key env variable name', () => {
      expect(GOOGLE_API_KEY_ENV).toBe('GOOGLE_GENERATIVE_AI_API_KEY')
    })
  })

  describe('createGoogleGateway', () => {
    it('should create gateway with provider name google', () => {
      const gateway = createGoogleGateway({ apiKey: 'test-key' })
      expect(gateway.providerName).toBe('google')
    })

    it('should be available when API key is provided', () => {
      const gateway = createGoogleGateway({ apiKey: 'test-key' })
      expect(gateway.isAvailable()).toBe(true)
    })

    it('should not be available when API key is empty', () => {
      const gateway = createGoogleGateway({ apiKey: '' })
      expect(gateway.isAvailable()).toBe(false)
    })

    it('should use environment variable for API key', () => {
      process.env[GOOGLE_API_KEY_ENV] = 'env-test-key'
      const gateway = createGoogleGateway()
      expect(gateway.isAvailable()).toBe(true)
    })

    it('should prefer config API key over environment variable', () => {
      process.env[GOOGLE_API_KEY_ENV] = 'env-test-key'
      const gateway = createGoogleGateway({ apiKey: 'config-key' })
      expect(gateway.isAvailable()).toBe(true)
    })

    it('should not be available without any API key', () => {
      delete process.env[GOOGLE_API_KEY_ENV]
      const gateway = createGoogleGateway()
      expect(gateway.isAvailable()).toBe(false)
    })
  })

  describe('googleGateway default instance', () => {
    it('should be a valid LlmGateway', () => {
      expect(googleGateway.providerName).toBe('google')
      expect(typeof googleGateway.isAvailable).toBe('function')
      expect(typeof googleGateway.complete).toBe('function')
      expect(typeof googleGateway.streamCompletion).toBe('function')
    })
  })

  describe('complete', () => {
    it('should return text and usage on successful completion', async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: 'Hello, world!',
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        },
        finishReason: 'stop',
        toolCalls: [],
      } as unknown as Awaited<ReturnType<typeof generateText>>)

      const gateway = createGoogleGateway({ apiKey: 'test-key' })
      const result = await gateway.complete('gemini-2.0-flash', [
        { role: 'user', content: 'Say hello' },
      ])

      expect(result.text).toBe('Hello, world!')
      expect(result.usage.promptTokens).toBe(10)
      expect(result.usage.completionTokens).toBe(5)
      expect(result.usage.totalTokens).toBe(15)
      expect(result.finishReason).toBe('stop')
    })

    it('should pass messages and options to generateText', async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: 'Response',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        finishReason: 'stop',
        toolCalls: [],
      } as unknown as Awaited<ReturnType<typeof generateText>>)

      const gateway = createGoogleGateway({ apiKey: 'test-key' })
      await gateway.complete('gemini-2.0-flash', [{ role: 'user', content: 'Test' }], {
        system: 'You are helpful',
        maxTokens: 100,
        temperature: 0.5,
        topP: 0.9,
        stopSequences: ['STOP'],
      })

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'You are helpful',
          maxTokens: 100,
          temperature: 0.5,
          topP: 0.9,
          stopSequences: ['STOP'],
        }),
      )
    })

    it('should handle tool calls', async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: '',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'tool-calls',
        toolCalls: [
          {
            toolCallId: 'call-1',
            toolName: 'get_weather',
            args: { location: 'Tokyo' },
          },
        ],
      } as unknown as Awaited<ReturnType<typeof generateText>>)

      const gateway = createGoogleGateway({ apiKey: 'test-key' })
      const result = await gateway.complete('gemini-2.0-flash', [
        { role: 'user', content: 'What is the weather?' },
      ])

      expect(result.finishReason).toBe('tool-calls')
      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls?.[0]).toEqual({
        toolCallId: 'call-1',
        toolName: 'get_weather',
        args: { location: 'Tokyo' },
      })
    })

    it('should convert tools from ToolSpec to AI SDK format', async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: 'Response',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        finishReason: 'stop',
        toolCalls: [],
      } as unknown as Awaited<ReturnType<typeof generateText>>)

      const gateway = createGoogleGateway({ apiKey: 'test-key' })
      await gateway.complete('gemini-2.0-flash', [{ role: 'user', content: 'Test' }], {
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { location: { type: 'string' } },
              required: ['location'],
            },
          },
        ],
      })

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: {
            get_weather: {
              description: 'Get weather',
              parameters: expect.any(Object),
            },
          },
        }),
      )
    })

    it('should wrap provider errors in ProviderError', async () => {
      mockGenerateText.mockRejectedValueOnce(new Error('API error'))

      const gateway = createGoogleGateway({ apiKey: 'test-key' })

      await expect(
        gateway.complete('gemini-2.0-flash', [{ role: 'user', content: 'Test' }]),
      ).rejects.toThrow(ProviderError)

      await expect(
        gateway.complete('gemini-2.0-flash', [{ role: 'user', content: 'Test' }]),
      ).rejects.toThrow('Google completion failed: API error')
    })

    it('should map finish reasons correctly', async () => {
      const finishReasons: Array<[string | undefined, string]> = [
        ['stop', 'stop'],
        ['length', 'length'],
        ['tool-calls', 'tool-calls'],
        ['error', 'error'],
        ['unknown', 'other'],
        [undefined, 'other'],
      ]

      for (const [sdkReason, expectedReason] of finishReasons) {
        mockGenerateText.mockResolvedValueOnce({
          text: 'Response',
          usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
          finishReason: sdkReason,
          toolCalls: [],
        } as unknown as Awaited<ReturnType<typeof generateText>>)

        const gateway = createGoogleGateway({ apiKey: 'test-key' })
        const result = await gateway.complete('gemini-2.0-flash', [
          { role: 'user', content: 'Test' },
        ])

        expect(result.finishReason).toBe(expectedReason)
      }
    })
  })

  describe('streamCompletion', () => {
    it('should emit text-delta events for streamed text', async () => {
      const textChunks = ['Hello', ', ', 'world', '!']

      mockStreamText.mockResolvedValueOnce({
        textStream: (async function* () {
          for (const chunk of textChunks) {
            yield chunk
          }
        })(),
        usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 },
        finishReason: 'stop',
        toolCalls: [],
      } as unknown as Awaited<ReturnType<typeof streamText>>)

      const gateway = createGoogleGateway({ apiKey: 'test-key' })
      const events: LlmStreamEvent[] = []
      await gateway.streamCompletion(
        'gemini-2.0-flash',
        [{ role: 'user', content: 'Test' }],
        (event) => events.push(event),
      )

      const textDeltas = events.filter((e) => e.type === 'text-delta')
      expect(textDeltas).toHaveLength(4)
      expect(textDeltas.map((e) => (e as { delta: string }).delta).join('')).toBe('Hello, world!')
    })

    it('should emit usage event after streaming', async () => {
      mockStreamText.mockResolvedValueOnce({
        textStream: (async function* () {
          yield 'test'
        })(),
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'stop',
        toolCalls: [],
      } as unknown as Awaited<ReturnType<typeof streamText>>)

      const gateway = createGoogleGateway({ apiKey: 'test-key' })
      const events: LlmStreamEvent[] = []
      await gateway.streamCompletion(
        'gemini-2.0-flash',
        [{ role: 'user', content: 'Test' }],
        (event) => events.push(event),
      )

      const usageEvents = events.filter((e) => e.type === 'usage')
      expect(usageEvents).toHaveLength(1)
      const usageEvent = usageEvents[0] as {
        usage: { promptTokens: number; completionTokens: number; totalTokens: number }
      }
      expect(usageEvent.usage.promptTokens).toBe(10)
      expect(usageEvent.usage.completionTokens).toBe(5)
      expect(usageEvent.usage.totalTokens).toBe(15)
    })

    it('should emit finish event with finish reason', async () => {
      mockStreamText.mockResolvedValueOnce({
        textStream: (async function* () {
          yield 'test'
        })(),
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        finishReason: 'stop',
        toolCalls: [],
      } as unknown as Awaited<ReturnType<typeof streamText>>)

      const gateway = createGoogleGateway({ apiKey: 'test-key' })
      const events: LlmStreamEvent[] = []
      await gateway.streamCompletion(
        'gemini-2.0-flash',
        [{ role: 'user', content: 'Test' }],
        (event) => events.push(event),
      )

      const finishEvents = events.filter((e) => e.type === 'finish')
      expect(finishEvents).toHaveLength(1)
      expect((finishEvents[0] as { finishReason: string }).finishReason).toBe('stop')
    })

    it('should emit tool-call events for tool calls', async () => {
      mockStreamText.mockResolvedValueOnce({
        textStream: (async function* () {
          yield ''
        })(),
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        finishReason: 'tool-calls',
        toolCalls: [
          {
            toolCallId: 'call-1',
            toolName: 'search',
            args: { query: 'test' },
          },
        ],
      } as unknown as Awaited<ReturnType<typeof streamText>>)

      const gateway = createGoogleGateway({ apiKey: 'test-key' })
      const events: LlmStreamEvent[] = []
      await gateway.streamCompletion(
        'gemini-2.0-flash',
        [{ role: 'user', content: 'Test' }],
        (event) => events.push(event),
      )

      const toolCallEvents = events.filter((e) => e.type === 'tool-call')
      expect(toolCallEvents).toHaveLength(1)
      const toolCallEvent = toolCallEvents[0] as {
        toolCallId: string
        toolName: string
        args: unknown
      }
      expect(toolCallEvent.toolCallId).toBe('call-1')
      expect(toolCallEvent.toolName).toBe('search')
      expect(toolCallEvent.args).toEqual({ query: 'test' })
    })

    it('should emit error event on provider error', async () => {
      mockStreamText.mockRejectedValueOnce(new Error('Stream error'))

      const gateway = createGoogleGateway({ apiKey: 'test-key' })
      const events: LlmStreamEvent[] = []
      await gateway.streamCompletion(
        'gemini-2.0-flash',
        [{ role: 'user', content: 'Test' }],
        (event) => events.push(event),
      )

      const errorEvents = events.filter((e) => e.type === 'error')
      expect(errorEvents).toHaveLength(1)
      const errorEvent = errorEvents[0] as { error: Error }
      expect(errorEvent.error).toBeInstanceOf(ProviderError)
      expect(errorEvent.error.message).toContain('Stream error')
    })

    it('should emit error event on abort', async () => {
      const abortError = new Error('Aborted')
      abortError.name = 'AbortError'
      mockStreamText.mockRejectedValueOnce(abortError)

      const gateway = createGoogleGateway({ apiKey: 'test-key' })
      const events: LlmStreamEvent[] = []
      await gateway.streamCompletion(
        'gemini-2.0-flash',
        [{ role: 'user', content: 'Test' }],
        (event) => events.push(event),
      )

      const errorEvents = events.filter((e) => e.type === 'error')
      expect(errorEvents).toHaveLength(1)
      const errorEvent = errorEvents[0] as { error: Error }
      expect(errorEvent.error.name).toBe('AbortError')
    })

    it('should pass options to streamText', async () => {
      mockStreamText.mockResolvedValueOnce({
        textStream: (async function* () {
          yield 'test'
        })(),
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
        finishReason: 'stop',
        toolCalls: [],
      } as unknown as Awaited<ReturnType<typeof streamText>>)

      const gateway = createGoogleGateway({ apiKey: 'test-key' })
      await gateway.streamCompletion(
        'gemini-2.0-flash',
        [{ role: 'user', content: 'Test' }],
        () => {},
        {
          system: 'You are helpful',
          maxTokens: 100,
          temperature: 0.7,
        },
      )

      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'You are helpful',
          maxTokens: 100,
          temperature: 0.7,
        }),
      )
    })
  })
})
