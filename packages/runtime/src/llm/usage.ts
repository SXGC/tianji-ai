import type { LanguageModelUsage } from 'ai'

import type { LlmCost, LlmPricing, LlmUsage } from './index.js'

function roundUsd(value: number): number {
  return Number(value.toFixed(8))
}

function calculateCost(tokens: number, pricePerMillionUsd: number): number {
  return roundUsd((tokens / 1_000_000) * pricePerMillionUsd)
}

export function collectLlmUsage(
  sdkUsage: Pick<LanguageModelUsage, 'promptTokens' | 'completionTokens' | 'totalTokens'>,
  pricing?: LlmPricing
): LlmUsage {
  const inputTokens = sdkUsage.promptTokens ?? 0
  const outputTokens = sdkUsage.completionTokens ?? 0
  const totalTokens = sdkUsage.totalTokens ?? inputTokens + outputTokens

  const cost: LlmCost =
    pricing === undefined
      ? {
          currency: 'USD',
          inputCost: 0,
          outputCost: 0,
          totalCost: 0,
          pricingSource: 'unavailable',
        }
      : {
          currency: 'USD',
          inputCost: calculateCost(inputTokens, pricing.inputCostPerMillionUsd),
          outputCost: calculateCost(outputTokens, pricing.outputCostPerMillionUsd),
          totalCost: roundUsd(
            calculateCost(inputTokens, pricing.inputCostPerMillionUsd) +
              calculateCost(outputTokens, pricing.outputCostPerMillionUsd)
          ),
          pricingSource: 'configured',
        }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cost,
  }
}
