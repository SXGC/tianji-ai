/**
 * Anthropic provider adapter for the LLM gateway.
 * Implements LlmGateway using @ai-sdk/anthropic.
 */

import { type AnthropicProviderSettings, createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModelV1 } from '@ai-sdk/provider'
import { ProviderError } from '@tianji/contracts'
import { generateText, streamText } from 'ai'
import { appMessagesToCoreMessages } from './message-conversion.js'
import { toolSpecToAiSdkTool } from './tool-schema-bridge.js'
import type {
  AppMessage,
  LlmCompletionOptions,
  LlmCompletionResult,
  LlmGateway,
  LlmProviderConfig,
  LlmStreamEvent,
  LlmStreamHandler,
} from './types.js'
import { type TokenUsage, normalizeUsage } from './usage.js'

/**
 * Anthropic provider configuration.
 */
export interface AnthropicConfig extends LlmProviderConfig {
  /** Enable Anthropic cache control */
  cacheControl?: boolean
  /** Include reasoning content in requests */
  sendReasoning?: boolean
}

/**
 * Default model for Anthropic.
 */
export const ANTHROPIC_DEFAULT_MODEL = 'claude-3-5-sonnet-latest'

/**
 * Environment variable name for API key.
 */
export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY'

/**
 * Create an Anthropic LLM gateway.
 * @param config - Optional configuration for the provider
 * @returns An LlmGateway implementation for Anthropic
 */
export function createAnthropicGateway(config?: AnthropicConfig): LlmGateway {
  const apiKey = config?.apiKey ?? process.env[ANTHROPIC_API_KEY_ENV]
  const providerSettings: AnthropicProviderSettings = {
    apiKey,
    baseURL: config?.baseUrl,
    headers: config?.headers,
  }

  // Create provider instance (use default if no config)
  const provider = apiKey ? createAnthropic(providerSettings) : createAnthropic()

  /**
   * Get a model instance from the provider.
   */
  function getModel(modelId: string, settings?: AnthropicConfig): LanguageModelV1 {
    return provider(modelId, {
      cacheControl: settings?.cacheControl,
      sendReasoning: settings?.sendReasoning,
    })
  }

  /**
   * Map AI SDK finish reason to our normalized finish reason.
   */
  function mapFinishReason(reason: string | undefined): LlmCompletionResult['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop'
      case 'length':
        return 'length'
      case 'tool-calls':
        return 'tool-calls'
      case 'error':
        return 'error'
      default:
        return 'other'
    }
  }

  return {
    providerName: 'anthropic',

    isAvailable(): boolean {
      return typeof apiKey === 'string' && apiKey.length > 0
    },

    async complete(
      model: string,
      messages: AppMessage[],
      options?: LlmCompletionOptions,
    ): Promise<LlmCompletionResult> {
      try {
        const coreMessages = appMessagesToCoreMessages(messages)

        // Build tools if provided
        const tools = options?.tools
          ? Object.fromEntries(options.tools.map((spec) => [spec.name, toolSpecToAiSdkTool(spec)]))
          : undefined

        const result = await generateText({
          model: getModel(model, config),
          messages: coreMessages,
          system: options?.system,
          maxTokens: options?.maxTokens,
          temperature: options?.temperature,
          topP: options?.topP,
          stopSequences: options?.stopSequences,
          tools,
          abortSignal: options?.abortSignal,
        })

        // Extract tool calls if any
        const toolCalls = result.toolCalls?.length
          ? result.toolCalls.map((tc) => ({
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.args,
            }))
          : undefined

        return {
          text: result.text,
          usage: normalizeUsage({
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
          }),
          finishReason: mapFinishReason(result.finishReason),
          toolCalls,
        }
      } catch (error) {
        // Wrap provider errors
        if (error instanceof Error) {
          throw new ProviderError(
            'anthropic_complete_error',
            `Anthropic completion failed: ${error.message}`,
            error instanceof ProviderError ? error : undefined,
          )
        }
        throw new ProviderError(
          'anthropic_complete_error',
          'Anthropic completion failed with unknown error',
        )
      }
    },

    async streamCompletion(
      model: string,
      messages: AppMessage[],
      handler: LlmStreamHandler,
      options?: LlmCompletionOptions,
    ): Promise<void> {
      try {
        const coreMessages = appMessagesToCoreMessages(messages)

        // Build tools if provided
        const tools = options?.tools
          ? Object.fromEntries(options.tools.map((spec) => [spec.name, toolSpecToAiSdkTool(spec)]))
          : undefined

        const result = streamText({
          model: getModel(model, config),
          messages: coreMessages,
          system: options?.system,
          maxTokens: options?.maxTokens,
          temperature: options?.temperature,
          topP: options?.topP,
          stopSequences: options?.stopSequences,
          tools,
          abortSignal: options?.abortSignal,
        })

        let usage: TokenUsage = {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        }

        // Process the stream
        for await (const chunk of (await result).textStream) {
          handler({ type: 'text', content: chunk })
        }

        // Get final result for usage and tool calls
        const finalResult = await await result

        // Emit usage event
        usage = normalizeUsage({
          promptTokens: finalResult.usage.promptTokens,
          completionTokens: finalResult.usage.completionTokens,
          totalTokens: finalResult.usage.totalTokens,
        })
        handler({ type: 'usage', usage })

        // Emit tool call events if any
        if (finalResult.toolCalls?.length) {
          for (const tc of finalResult.toolCalls) {
            handler({
              type: 'tool-call',
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.args,
            })
          }
        }

        // Emit done event
        handler({
          type: 'done',
          finishReason: mapFinishReason(finalResult.finishReason),
        })
      } catch (error) {
        // Wrap provider errors
        if (error instanceof Error) {
          // Check if it's an abort error
          if (error.name === 'AbortError') {
            handler({ type: 'error', error })
            return
          }

          handler({
            type: 'error',
            error: new ProviderError(
              'anthropic_stream_error',
              `Anthropic streaming failed: ${error.message}`,
              error instanceof ProviderError ? error : undefined,
            ),
          })
        } else {
          handler({
            type: 'error',
            error: new ProviderError(
              'anthropic_stream_error',
              'Anthropic streaming failed with unknown error',
            ),
          })
        }
      }
    },
  }
}

/**
 * Default Anthropic gateway instance.
 * Uses environment variable ANTHROPIC_API_KEY for authentication.
 */
export const anthropicGateway: LlmGateway = createAnthropicGateway()
