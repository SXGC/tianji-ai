import type { AppMessage, RunId, ToolInvocation, ToolResult, ToolSpec } from '@tianji/shared'

export type LlmProvider = 'openai' | 'anthropic' | 'google'

export interface LlmPricing {
  readonly inputCostPerMillionUsd: number
  readonly outputCostPerMillionUsd: number
}

export interface LlmProviderConfig {
  readonly provider: LlmProvider
  readonly model: string
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly headers?: Record<string, string>
  readonly options?: Record<string, unknown>
  readonly pricing?: LlmPricing
}

export interface LlmGenerationConfig {
  readonly temperature?: number
  readonly maxTokens?: number
  readonly topP?: number
  readonly stopSequences?: readonly string[]
  readonly seed?: number
  readonly maxSteps?: number
  readonly extra?: Record<string, unknown>
}

export interface LlmToolExecutionOptions {
  readonly toolCallId: string
  readonly abortSignal?: AbortSignal
}

export type LlmToolExecutor = (
  toolName: string,
  args: unknown,
  options: LlmToolExecutionOptions
) => Promise<unknown>

export interface LlmRequest {
  readonly runId: RunId
  readonly messages: readonly AppMessage[]
  readonly config?: LlmGenerationConfig
  readonly systemPrompt?: string
  readonly tools?: readonly ToolSpec[]
  readonly executeTool?: LlmToolExecutor
  readonly headers?: Record<string, string>
  readonly abortSignal?: AbortSignal
}

export interface LlmCost {
  readonly currency: 'USD'
  readonly inputCost: number
  readonly outputCost: number
  readonly totalCost: number
  readonly pricingSource: 'configured' | 'unavailable'
}

export interface LlmUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cost: LlmCost
}

export interface LlmResponseMeta {
  readonly provider: LlmProvider
  readonly model: string
  readonly requestId?: string
  readonly latencyMs?: number
}

export interface LlmResponse {
  readonly content: string
  readonly usage: LlmUsage
  readonly meta: LlmResponseMeta
  readonly finishReason: string
  readonly toolCalls: readonly ToolInvocation[]
  readonly toolResults: readonly ToolResult[]
}

export interface LlmStreamDelta {
  readonly delta: string
  readonly isFinal: boolean
}

export interface LlmStreamComplete {
  readonly response: LlmResponse
}

export interface LlmStreamError {
  readonly message: string
  readonly code?: string
}

export type LlmStreamEvent =
  | { readonly type: 'delta'; readonly payload: LlmStreamDelta }
  | { readonly type: 'complete'; readonly payload: LlmStreamComplete }
  | { readonly type: 'error'; readonly payload: LlmStreamError }

export type LlmStreamCallback = (event: LlmStreamEvent) => void

export interface LlmStream {
  readonly onEvent: (callback: LlmStreamCallback) => void
  readonly abort: () => void
  readonly waitUntilComplete: () => Promise<LlmResponse>
}

export interface LlmGateway {
  readonly generate: (request: LlmRequest) => Promise<LlmResponse>
  readonly stream: (request: LlmRequest) => Promise<LlmStream>
  readonly isReady: () => boolean
  readonly getProviderInfo: () => {
    provider: LlmProvider
    model: string
  }
}

export { createAnthropicGateway } from './anthropic-gateway.js'
export { createLlmGateway } from './factory.js'
export { createGoogleGateway } from './google-gateway.js'
export { ConversionError } from './message-conversion.js'
export { createOpenAIGateway } from './openai-gateway.js'
export { ToolSchemaError } from './tool-schema-bridge.js'
export { collectLlmUsage } from './usage.js'
