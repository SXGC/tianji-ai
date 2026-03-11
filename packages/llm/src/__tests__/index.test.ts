/**
 * Tests for @tianji/llm package exports and interfaces.
 *
 * This test verifies:
 * - Package can be imported
 * - Interface types are exported correctly
 * - Package dependencies are correct (only @tianji/contracts and @tianji/shared)
 */
import { createRunId } from '@tianji/contracts'

import { describe, expect, it } from 'vitest'
import type {
  LlmCost,
  LlmGateway,
  LlmGenerationConfig,
  LlmPricing,
  LlmProvider,
  LlmProviderConfig,
  LlmRequest,
  LlmResponse,
  LlmResponseMeta,
  LlmStream,
  LlmStreamCallback,
  LlmStreamComplete,
  LlmStreamDelta,
  LlmStreamError,
  LlmStreamEvent,
  LlmToolExecutionOptions,
  LlmToolExecutor,
  LlmUsage,
} from '../index.js'

/** Minimal type for package.json dependency checking */
interface PackageJson {
  dependencies?: Record<string, string>
}

describe('@tianji/llm', () => {
  describe('package exports', () => {
    it('should be importable', async () => {
      const llm = await import('../index.js')
      expect(llm).toBeDefined()
    })

    it('should export provider types', async () => {
      // Verify provider type exports exist at compile time
      // These are type-only exports, so we verify they compile
      const _providerTypes: LlmProvider = 'openai'
      const _providerConfig: LlmProviderConfig = {
        provider: 'openai',
        model: 'gpt-4',
      }
      expect(_providerTypes).toBeDefined()
      expect(_providerConfig).toBeDefined()
    })

    it('should export gateway factory', async () => {
      const llm = await import('../index.js')
      expect(llm.createLlmGateway).toBeDefined()
      expect(llm.createOpenAIGateway).toBeDefined()
      expect(llm.createAnthropicGateway).toBeDefined()
      expect(llm.createGoogleGateway).toBeDefined()
      expect(llm.collectLlmUsage).toBeDefined()
    })

    it('should export request/response types', async () => {
      const _pricing: LlmPricing = {
        inputCostPerMillionUsd: 2,
        outputCostPerMillionUsd: 8,
      }

      const _cost: LlmCost = {
        currency: 'USD',
        inputCost: 0.1,
        outputCost: 0.2,
        totalCost: 0.3,
        pricingSource: 'configured',
      }

      // Verify request/response type exports compile correctly
      const _usage: LlmUsage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cost: _cost,
      }

      const _meta: LlmResponseMeta = {
        provider: 'openai',
        model: 'gpt-4',
        requestId: 'req-123',
        latencyMs: 500,
      }

      const _response: LlmResponse = {
        content: 'Hello, world!',
        usage: _usage,
        meta: _meta,
        finishReason: 'stop',
        toolCalls: [],
        toolResults: [],
      }

      const _config: LlmGenerationConfig = {
        temperature: 0.7,
        maxTokens: 1000,
      }

      expect(_usage).toBeDefined()
      expect(_pricing).toBeDefined()
      expect(_cost).toBeDefined()
      expect(_meta).toBeDefined()
      expect(_response).toBeDefined()
      expect(_config).toBeDefined()
    })

    it('should export streaming types', async () => {
      // Verify streaming type exports compile correctly
      const _delta: LlmStreamDelta = {
        delta: 'Hello',
        isFinal: false,
      }

      const _complete: LlmStreamComplete = {
        response: {
          content: 'Hello, world!',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            cost: {
              currency: 'USD',
              inputCost: 0,
              outputCost: 0,
              totalCost: 0,
              pricingSource: 'unavailable',
            },
          },
          meta: { provider: 'openai', model: 'gpt-4' },
          finishReason: 'stop',
          toolCalls: [],
          toolResults: [],
        },
      }

      const _error: LlmStreamError = {
        message: 'Generation failed',
        code: 'RATE_LIMIT',
      }

      const _event: LlmStreamEvent = { type: 'delta', payload: _delta }

      expect(_delta).toBeDefined()
      expect(_complete).toBeDefined()
      expect(_error).toBeDefined()
      expect(_event).toBeDefined()
    })

    it('should export gateway and stream interfaces', async () => {
      // Verify interface types can be used in type annotations
      // We create mock implementations to verify interface shape

      const mockStream: LlmStream = {
        onEvent: (_callback: LlmStreamCallback) => {},
        abort: () => {},
        waitUntilComplete: async () => ({
          content: 'test',
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
          meta: { provider: 'openai', model: 'gpt-4' },
          finishReason: 'stop',
          toolCalls: [],
          toolResults: [],
        }),
      }

      const _toolExecutionOptions: LlmToolExecutionOptions = {}
      const _toolExecutor: LlmToolExecutor = async (_toolName, _args, _options) => ({ ok: true })

      const mockGateway: LlmGateway = {
        generate: async (_request: LlmRequest) => ({
          content: 'test',
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
          meta: { provider: 'openai', model: 'gpt-4' },
          finishReason: 'stop',
          toolCalls: [],
          toolResults: [],
        }),
        stream: async (_request: LlmRequest) => mockStream,
        isReady: () => true,
        getProviderInfo: () => ({ provider: 'openai', model: 'gpt-4' }),
      }

      expect(mockStream).toBeDefined()
      expect(mockGateway).toBeDefined()
      expect(_toolExecutionOptions).toBeDefined()
      expect(_toolExecutor).toBeDefined()
    })
  })

  describe('dependency constraints', () => {
    it('should depend only on allowed internal packages', async () => {
      // Import package.json to verify dependencies
      const pkg = (await import('../../package.json', {
        assert: { type: 'json' },
      })) as { default: PackageJson }
      const dependencies = pkg.default.dependencies || {}

      // Check that dependencies only include allowed packages
      const allowedDeps = [
        '@ai-sdk/anthropic',
        '@ai-sdk/google',
        '@ai-sdk/openai',
        '@tianji/contracts',
        '@tianji/shared',
        'ai',
      ]
      const actualDeps = Object.keys(dependencies)

      // All dependencies must be in allowed list
      for (const dep of actualDeps) {
        expect(allowedDeps).toContain(dep)
      }
    })
  })

  describe('interface shape validation', () => {
    it('should allow valid LlmRequest construction', () => {
      // Use createRunId from contracts to verify integration

      const request: LlmRequest = {
        runId: createRunId('run-123'),
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: [{ type: 'text', text: 'Hello' }],
            createdAt: Date.now(),
          },
        ],
        config: {
          temperature: 0.7,
          maxTokens: 100,
        },
        systemPrompt: 'You are a helpful assistant.',
        tools: [],
      }

      expect(request.runId).toBeDefined()
      expect(request.messages).toHaveLength(1)
    })

    it('should allow discriminated union narrowing on LlmStreamEvent', () => {
      const events: LlmStreamEvent[] = [
        { type: 'delta', payload: { delta: 'Hello', isFinal: false } },
        {
          type: 'complete',
          payload: {
            response: {
              content: 'Hello!',
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
              meta: { provider: 'openai', model: 'gpt-4' },
              finishReason: 'stop',
              toolCalls: [],
              toolResults: [],
            },
          },
        },
        { type: 'error', payload: { message: 'Failed' } },
      ]

      for (const event of events) {
        if (event.type === 'delta') {
          expect(typeof event.payload.delta).toBe('string')
        } else if (event.type === 'complete') {
          expect(event.payload.response.content).toBeDefined()
        } else if (event.type === 'error') {
          expect(event.payload.message).toBeDefined()
        }
      }
    })
  })
})
