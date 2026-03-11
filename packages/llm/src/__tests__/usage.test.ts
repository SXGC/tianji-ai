import { describe, expect, it } from 'vitest'

import { collectLlmUsage } from '../usage.js'

describe('collectLlmUsage', () => {
  it('maps sdk usage tokens without pricing', () => {
    const usage = collectLlmUsage({
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
    })

    expect(usage).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      cost: {
        currency: 'USD',
        inputCost: 0,
        outputCost: 0,
        totalCost: 0,
        pricingSource: 'unavailable',
      },
    })
  })

  it('calculates configured usd cost', () => {
    const usage = collectLlmUsage(
      {
        promptTokens: 1_000,
        completionTokens: 2_000,
        totalTokens: 3_000,
      },
      {
        inputCostPerMillionUsd: 2,
        outputCostPerMillionUsd: 4,
      }
    )

    expect(usage.cost).toEqual({
      currency: 'USD',
      inputCost: 0.002,
      outputCost: 0.008,
      totalCost: 0.01,
      pricingSource: 'configured',
    })
  })
})
