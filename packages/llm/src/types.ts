/**
 * Project-owned types for LLM operations.
 * These types are independent of any specific LLM provider SDK.
 */

import type { ToolSpec } from '@tianji/contracts'
import type { TokenUsage } from './usage.js'

/**
 * A text part within a message.
 */
export interface TextPart {
  type: 'text'
  text: string
}

/**
 * A reasoning part within a message (for models that support chain-of-thought).
 */
export interface ReasoningPart {
  type: 'reasoning'
  text: string
}

/**
 * An image part within a message.
 */
export interface ImagePart {
  type: 'image'
  /** Base64-encoded image data or URL */
  image: string | URL
  mimeType?: string
}

/**
 * A tool call within an assistant message.
 */
export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  args: unknown
}

/**
 * A tool result within a tool message.
 */
export interface ToolResultPart {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  result: unknown
  isError?: boolean
}

/**
 * Union type for all message content parts.
 */
export type MessagePart = TextPart | ReasoningPart | ImagePart | ToolCallPart | ToolResultPart

/**
 * User message content.
 */
export interface AppUserMessage {
  role: 'user'
  content: string | MessagePart[]
}

/**
 * Assistant message content.
 */
export interface AppAssistantMessage {
  role: 'assistant'
  content: string | MessagePart[]
}

/**
 * System message content.
 */
export interface AppSystemMessage {
  role: 'system'
  content: string
}

/**
 * Tool message content.
 */
export interface AppToolMessage {
  role: 'tool'
  content: ToolResultPart[]
}

/**
 * Union type for all application messages.
 */
export type AppMessage = AppUserMessage | AppAssistantMessage | AppSystemMessage | AppToolMessage

/**
 * Options for LLM completion requests.
 */
export interface LlmCompletionOptions {
  /** System prompt to prepend to messages */
  system?: string
  /** Maximum tokens to generate */
  maxTokens?: number
  /** Temperature for sampling (0-2) */
  temperature?: number
  /** Top-p sampling parameter */
  topP?: number
  /** Stop sequences */
  stopSequences?: string[]
  /** Tools available for the model to call */
  tools?: ToolSpec[]
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal
}

/**
 * Result of a non-streaming completion.
 */
export interface LlmCompletionResult {
  /** The generated text content */
  text: string
  /** Token usage statistics */
  usage: TokenUsage
  /** Reason for completion (stop, length, tool-calls, etc.) */
  finishReason: 'stop' | 'length' | 'tool-calls' | 'error' | 'other'
  /** Tool calls if any were made */
  toolCalls?: Array<{
    toolCallId: string
    toolName: string
    args: unknown
  }>
}

/**
 * Events emitted during streaming completion.
 */
export type LlmStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'reasoning-delta'; delta: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; finishReason: 'stop' | 'length' | 'tool-calls' | 'error' | 'other' }
  | { type: 'error'; error: Error }

/**
 * Callback function for handling stream events.
 */
export type LlmStreamHandler = (event: LlmStreamEvent) => void

/**
 * Gateway interface for LLM operations.
 * Provides a provider-agnostic API for text generation.
 */
export interface LlmGateway {
  /** Provider name identifier */
  readonly providerName: string

  /**
   * Check if the provider is available and properly configured.
   */
  isAvailable(): boolean

  /**
   * Perform a non-streaming completion.
   * @param model - Model identifier
   * @param messages - Conversation messages
   * @param options - Completion options
   */
  complete(
    model: string,
    messages: AppMessage[],
    options?: LlmCompletionOptions,
  ): Promise<LlmCompletionResult>

  /**
   * Perform a streaming completion.
   * @param model - Model identifier
   * @param messages - Conversation messages
   * @param handler - Callback for stream events
   * @param options - Completion options
   */
  streamCompletion(
    model: string,
    messages: AppMessage[],
    handler: LlmStreamHandler,
    options?: LlmCompletionOptions,
  ): Promise<void>
}

/**
 * Configuration for creating an LLM provider.
 */
export interface LlmProviderConfig {
  /** API key for authentication */
  apiKey?: string
  /** Base URL for API requests (optional override) */
  baseUrl?: string
  /** Default model to use */
  defaultModel?: string
  /** Default headers to include in requests */
  headers?: Record<string, string>
}
