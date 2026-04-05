import { describe, expect, it } from 'vitest'

import { collectLlmUsage } from '../llm/usage.js'

describe('collectLlmUsage', () => {
  it('returns pricingSource "unavailable" when pricing is not provided', () => {
    const usage = collectLlmUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 })

    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(50)
    expect(usage.totalTokens).toBe(150)
    expect(usage.cost).toEqual({
      currency: 'USD',
      inputCost: 0,
      outputCost: 0,
      totalCost: 0,
      pricingSource: 'unavailable',
    })
  })

  it('calculates costs correctly with pricing', () => {
    const pricing = { inputCostPerMillionUsd: 3.0, outputCostPerMillionUsd: 15.0 }
    const usage = collectLlmUsage(
      { promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000 },
      pricing
    )

    expect(usage.inputTokens).toBe(1_000_000)
    expect(usage.outputTokens).toBe(500_000)
    expect(usage.totalTokens).toBe(1_500_000)
    expect(usage.cost.pricingSource).toBe('configured')
    expect(usage.cost.inputCost).toBe(3.0)
    expect(usage.cost.outputCost).toBe(7.5)
    expect(usage.cost.totalCost).toBe(10.5)
  })

  it('handles small token counts with precise rounding', () => {
    const pricing = { inputCostPerMillionUsd: 3.0, outputCostPerMillionUsd: 15.0 }
    const usage = collectLlmUsage(
      { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      pricing
    )

    expect(usage.cost.inputCost).toBe(0.0003)
    expect(usage.cost.outputCost).toBe(0.00075)
    expect(usage.cost.totalCost).toBe(0.00105)
  })

  it('handles zero tokens', () => {
    const pricing = { inputCostPerMillionUsd: 3.0, outputCostPerMillionUsd: 15.0 }
    const usage = collectLlmUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }, pricing)

    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
    expect(usage.totalTokens).toBe(0)
    expect(usage.cost.inputCost).toBe(0)
    expect(usage.cost.outputCost).toBe(0)
    expect(usage.cost.totalCost).toBe(0)
  })

  it('sums input+output when totalTokens is missing', () => {
    const sdkUsage = {
      promptTokens: 200,
      completionTokens: 100,
      totalTokens: undefined as unknown as number,
    }
    const usage = collectLlmUsage(sdkUsage)

    expect(usage.totalTokens).toBe(300)
  })

  it('defaults promptTokens and completionTokens to 0 when missing', () => {
    const sdkUsage = {
      promptTokens: undefined as unknown as number,
      completionTokens: undefined as unknown as number,
      totalTokens: undefined as unknown as number,
    }
    const usage = collectLlmUsage(sdkUsage)

    expect(usage.inputTokens).toBe(0)
    expect(usage.outputTokens).toBe(0)
    expect(usage.totalTokens).toBe(0)
  })
})
