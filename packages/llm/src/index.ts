/**
 * @tianji/llm - LLM utilities for Tianji
 *
 * This package provides:
 * - Token usage normalization and cost calculation
 * - AI SDK integration helpers
 * - Tool schema bridge for converting ToolSpec to AI SDK tools
 */

export {
  type TokenUsage,
  type TokenRates,
  type UsageCost,
  type NormalizedUsage,
  normalizeUsage,
  calculateCost,
  normalizeUsageWithCost,
  zeroUsage,
  zeroCost,
} from './usage.js'

export { toolSpecToAiSdkTool } from './tool-schema-bridge.js'

export {
  createGoogleGateway,
  googleGateway,
  GOOGLE_API_KEY_ENV,
  GOOGLE_DEFAULT_MODEL,
  type GoogleConfig,
} from './google-provider.js'
