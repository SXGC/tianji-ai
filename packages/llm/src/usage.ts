/**
 * Usage and cost collection helpers for LLM operations.
 * Normalizes AI SDK usage data into project-owned types and computes costs.
 */

/**
 * Project-owned token usage type.
 * Represents the number of tokens used in an LLM call.
 */
export interface TokenUsage {
  /** Number of tokens in the prompt */
  promptTokens: number
  /** Number of tokens in the completion */
  completionTokens: number
  /** Total tokens (promptTokens + completionTokens) */
  totalTokens: number
}

/**
 * Token rates for cost calculation.
 * Rates are per 1000 tokens.
 */
export interface TokenRates {
  /** Cost per 1000 prompt tokens */
  promptRate: number
  /** Cost per 1000 completion tokens */
  completionRate: number
}

/**
 * Computed cost from token usage.
 */
export interface UsageCost {
  /** Cost for prompt tokens */
  promptCost: number
  /** Cost for completion tokens */
  completionCost: number
  /** Total cost (promptCost + completionCost) */
  totalCost: number
}

/**
 * Normalized usage data with optional cost.
 */
export interface NormalizedUsage {
  usage: TokenUsage
  cost?: UsageCost
}

/**
 * AI SDK-like usage input shape.
 * Matches LanguageModelUsage from 'ai' package.
 */
interface AiSdkUsageLike {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/**
 * Normalize AI SDK usage to project-owned TokenUsage.
 * Preserves exact token counts from the source.
 *
 * @param sdkUsage - Usage object from AI SDK result
 * @returns Normalized TokenUsage
 */
export function normalizeUsage(sdkUsage: AiSdkUsageLike): TokenUsage {
  return {
    promptTokens: sdkUsage.promptTokens,
    completionTokens: sdkUsage.completionTokens,
    totalTokens: sdkUsage.totalTokens,
  }
}

/**
 * Calculate cost from token usage and rates.
 * Rates are per 1000 tokens.
 *
 * @param usage - Token usage data
 * @param rates - Token rates (per 1000 tokens)
 * @returns Computed cost breakdown
 */
export function calculateCost(usage: TokenUsage, rates: TokenRates): UsageCost {
  const promptCost = (usage.promptTokens / 1000) * rates.promptRate
  const completionCost = (usage.completionTokens / 1000) * rates.completionRate

  return {
    promptCost,
    completionCost,
    totalCost: promptCost + completionCost,
  }
}

/**
 * Normalize usage and optionally compute cost in one call.
 *
 * @param sdkUsage - Usage object from AI SDK result
 * @param rates - Optional token rates for cost calculation
 * @returns Normalized usage with optional cost
 */
export function normalizeUsageWithCost(
  sdkUsage: AiSdkUsageLike,
  rates?: TokenRates,
): NormalizedUsage {
  const usage = normalizeUsage(sdkUsage)

  return {
    usage,
    cost: rates ? calculateCost(usage, rates) : undefined,
  }
}

/**
 * Create a zero usage object.
 * Useful for initialization or fallback scenarios.
 */
export function zeroUsage(): TokenUsage {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  }
}

/**
 * Create a zero cost object.
 * Useful for initialization or when rates are zero.
 */
export function zeroCost(): UsageCost {
  return {
    promptCost: 0,
    completionCost: 0,
    totalCost: 0,
  }
}
