import { describe, expect, it } from 'vitest'
import {
  calculateCost,
  normalizeUsage,
  normalizeUsageWithCost,
  zeroCost,
  zeroUsage,
} from './usage.js'

describe('usage', () => {
  describe('normalizeUsage', () => {
    it('should preserve exact token counts from AI SDK usage', () => {
      const sdkUsage = {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      }

      const result = normalizeUsage(sdkUsage)

      expect(result).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      })
    })

    it('should handle zero tokens', () => {
      const sdkUsage = {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      }

      const result = normalizeUsage(sdkUsage)

      expect(result).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      })
    })

    it('should handle large token counts', () => {
      const sdkUsage = {
        promptTokens: 1000000,
        completionTokens: 500000,
        totalTokens: 1500000,
      }

      const result = normalizeUsage(sdkUsage)

      expect(result.promptTokens).toBe(1000000)
      expect(result.completionTokens).toBe(500000)
      expect(result.totalTokens).toBe(1500000)
    })
  })

  describe('calculateCost', () => {
    it('should compute cost deterministically from token rates', () => {
      const usage = {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      }

      const rates = {
        promptRate: 0.01, // $0.01 per 1000 prompt tokens
        completionRate: 0.03, // $0.03 per 1000 completion tokens
      }

      const result = calculateCost(usage, rates)

      expect(result.promptCost).toBe(0.01) // 1000/1000 * 0.01
      expect(result.completionCost).toBe(0.015) // 500/1000 * 0.03
      expect(result.totalCost).toBeCloseTo(0.025)
    })

    it('should return zero cost when rates are zero', () => {
      const usage = {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      }

      const rates = {
        promptRate: 0,
        completionRate: 0,
      }

      const result = calculateCost(usage, rates)

      expect(result.promptCost).toBe(0)
      expect(result.completionCost).toBe(0)
      expect(result.totalCost).toBe(0)
    })

    it('should handle fractional token counts correctly', () => {
      const usage = {
        promptTokens: 500,
        completionTokens: 250,
        totalTokens: 750,
      }

      const rates = {
        promptRate: 0.02,
        completionRate: 0.04,
      }

      const result = calculateCost(usage, rates)

      expect(result.promptCost).toBe(0.01) // 500/1000 * 0.02
      expect(result.completionCost).toBe(0.01) // 250/1000 * 0.04
      expect(result.totalCost).toBe(0.02)
    })

    it('should handle high-cost models', () => {
      const usage = {
        promptTokens: 1000,
        completionTokens: 1000,
        totalTokens: 2000,
      }

      const rates = {
        promptRate: 10, // $10 per 1000 tokens
        completionRate: 30, // $30 per 1000 tokens
      }

      const result = calculateCost(usage, rates)

      expect(result.promptCost).toBe(10)
      expect(result.completionCost).toBe(30)
      expect(result.totalCost).toBe(40)
    })
  })

  describe('normalizeUsageWithCost', () => {
    it('should return usage without cost when rates are not provided', () => {
      const sdkUsage = {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      }

      const result = normalizeUsageWithCost(sdkUsage)

      expect(result.usage).toEqual({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      })
      expect(result.cost).toBeUndefined()
    })

    it('should return usage with cost when rates are provided', () => {
      const sdkUsage = {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      }

      const rates = {
        promptRate: 0.01,
        completionRate: 0.03,
      }

      const result = normalizeUsageWithCost(sdkUsage, rates)

      expect(result.usage).toEqual({
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      })
      expect(result.cost).toEqual({
        promptCost: 0.01,
        completionCost: 0.015,
        totalCost: 0.025,
      })
    })
  })

  describe('zeroUsage', () => {
    it('should return a zero usage object', () => {
      const result = zeroUsage()

      expect(result).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      })
    })

    it('should return a new object each time', () => {
      const a = zeroUsage()
      const b = zeroUsage()

      expect(a).not.toBe(b)
      expect(a).toEqual(b)
    })
  })

  describe('zeroCost', () => {
    it('should return a zero cost object', () => {
      const result = zeroCost()

      expect(result).toEqual({
        promptCost: 0,
        completionCost: 0,
        totalCost: 0,
      })
    })

    it('should return a new object each time', () => {
      const a = zeroCost()
      const b = zeroCost()

      expect(a).not.toBe(b)
      expect(a).toEqual(b)
    })
  })
})
