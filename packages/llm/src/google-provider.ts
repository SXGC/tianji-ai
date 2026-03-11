/**
 * Google Generative AI provider adapter for the LLM gateway.
 * Implements LlmGateway using @ai-sdk/google.
 */

import { type GoogleGenerativeAIProviderSettings, createGoogleGenerativeAI } from '@ai-sdk/google'
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
  LlmStreamHandler,
} from './types.js'
import { type TokenUsage, normalizeUsage } from './usage.js'

/**
 * Google provider configuration.
 */
export interface GoogleConfig extends LlmProviderConfig {
  /** Custom provider name */
  providerName?: string
}

/**
 * Default model for Google.
 */
export const GOOGLE_DEFAULT_MODEL = 'gemini-2.0-flash'

/**
 * Environment variable name for API key.
 */
export const GOOGLE_API_KEY_ENV = 'GOOGLE_GENERATIVE_AI_API_KEY'

/**
 * Create a Google Generative AI LLM gateway.
 * @param config - Optional configuration for the provider
 * @returns An LlmGateway implementation for Google
 */
export function createGoogleGateway(config?: GoogleConfig): LlmGateway {
  const apiKey = config?.apiKey ?? process.env[GOOGLE_API_KEY_ENV]
  const providerSettings: GoogleGenerativeAIProviderSettings = {
    apiKey,
    baseURL: config?.baseUrl,
    headers: config?.headers,
  }

  // Create provider instance (use default if no config)
  const provider = apiKey ? createGoogleGenerativeAI(providerSettings) : createGoogleGenerativeAI()

  /**
   * Get a model instance from the provider.
   */
  function getModel(modelId: string): LanguageModelV1 {
    return provider(modelId)
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
    providerName: 'google',

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
          model: getModel(model),
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
            'google_complete_error',
            `Google completion failed: ${error.message}`,
            error instanceof ProviderError ? error : undefined,
          )
        }
        throw new ProviderError(
          'google_complete_error',
          'Google completion failed with unknown error',
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
          model: getModel(model),
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
          handler({ type: 'text-delta', delta: chunk })
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

        // Emit finish event
        handler({
          type: 'finish',
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
              'google_stream_error',
              `Google streaming failed: ${error.message}`,
              error instanceof ProviderError ? error : undefined,
            ),
          })
        } else {
          handler({
            type: 'error',
            error: new ProviderError(
              'google_stream_error',
              'Google streaming failed with unknown error',
            ),
          })
        }
      }
    },
  }
}

/**
 * Default Google gateway instance.
 * Uses environment variable GOOGLE_GENERATIVE_AI_API_KEY for authentication.
 */
export const googleGateway: LlmGateway = createGoogleGateway()
