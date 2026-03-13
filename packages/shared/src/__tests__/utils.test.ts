import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_RETRY_OPTIONS, deepClone, retry, sleep } from '../utils.js'

describe('utils', () => {
  describe('deepClone', () => {
    describe('primitives', () => {
      it('should clone null', () => {
        expect(deepClone(null)).toBe(null)
      })

      it('should clone undefined', () => {
        expect(deepClone(undefined)).toBe(undefined)
      })

      it('should clone numbers', () => {
        expect(deepClone(42)).toBe(42)
        expect(deepClone(0)).toBe(0)
        expect(deepClone(-1)).toBe(-1)
        expect(deepClone(3.14)).toBe(3.14)
        expect(deepClone(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
        expect(deepClone(Number.NaN)).toBeNaN()
      })

      it('should clone strings', () => {
        expect(deepClone('hello')).toBe('hello')
        expect(deepClone('')).toBe('')
      })

      it('should clone booleans', () => {
        expect(deepClone(true)).toBe(true)
        expect(deepClone(false)).toBe(false)
      })
    })

    describe('Date', () => {
      it('should clone Date objects', () => {
        const date = new Date('2024-01-15T10:30:00Z')
        const cloned = deepClone(date)

        expect(cloned).not.toBe(date)
        expect(cloned.getTime()).toBe(date.getTime())
      })

      it('should not affect original Date when cloned is modified', () => {
        const date = new Date('2024-01-15T10:30:00Z')
        const cloned = deepClone(date)

        cloned.setFullYear(2025)

        expect(date.getFullYear()).toBe(2024)
        expect(cloned.getFullYear()).toBe(2025)
      })
    })

    describe('Map', () => {
      it('should clone Map objects', () => {
        const map = new Map([
          ['a', 1],
          ['b', 2],
        ])
        const cloned = deepClone(map)

        expect(cloned).not.toBe(map)
        expect(cloned.size).toBe(2)
        expect(cloned.get('a')).toBe(1)
        expect(cloned.get('b')).toBe(2)
      })

      it('should deep clone Map values', () => {
        const map = new Map<string, { value: number }>()
        map.set('key', { value: 42 })
        const cloned = deepClone(map)

        const originalValue = map.get('key')
        const clonedValue = cloned.get('key')

        expect(clonedValue).not.toBe(originalValue)
        expect(clonedValue?.value).toBe(42)
      })
    })

    describe('Set', () => {
      it('should clone Set objects', () => {
        const set = new Set([1, 2, 3])
        const cloned = deepClone(set)

        expect(cloned).not.toBe(set)
        expect(cloned.size).toBe(3)
        expect(cloned.has(1)).toBe(true)
        expect(cloned.has(2)).toBe(true)
        expect(cloned.has(3)).toBe(true)
      })
    })

    describe('Arrays', () => {
      it('should clone arrays', () => {
        const arr = [1, 2, 3]
        const cloned = deepClone(arr)

        expect(cloned).not.toBe(arr)
        expect(cloned).toEqual([1, 2, 3])
      })

      it('should deep clone nested arrays', () => {
        const arr = [
          [1, 2],
          [3, 4],
        ]
        const cloned = deepClone(arr)

        expect(cloned).not.toBe(arr)
        expect(cloned[0]).not.toBe(arr[0])
        expect(cloned[1]).not.toBe(arr[1])
        expect(cloned).toEqual([
          [1, 2],
          [3, 4],
        ])
      })

      it('should clone arrays with mixed types', () => {
        const arr = [1, 'two', { three: 3 }, [4]]
        const cloned = deepClone(arr)

        expect(cloned).not.toBe(arr)
        expect(cloned[2]).not.toBe(arr[2])
        expect(cloned[3]).not.toBe(arr[3])
        expect(cloned).toEqual([1, 'two', { three: 3 }, [4]])
      })
    })

    describe('Objects', () => {
      it('should clone plain objects', () => {
        const obj = { a: 1, b: 'two' }
        const cloned = deepClone(obj)

        expect(cloned).not.toBe(obj)
        expect(cloned).toEqual({ a: 1, b: 'two' })
      })

      it('should deep clone nested objects', () => {
        const obj = {
          level1: {
            level2: {
              level3: 'deep',
            },
          },
        }
        const cloned = deepClone(obj)

        expect(cloned).not.toBe(obj)
        expect(cloned.level1).not.toBe(obj.level1)
        expect(cloned.level1.level2).not.toBe(obj.level1.level2)
        expect(cloned).toEqual({
          level1: {
            level2: {
              level3: 'deep',
            },
          },
        })
      })

      it('should clone objects with various value types', () => {
        const obj = {
          num: 42,
          str: 'hello',
          bool: true,
          null: null,
          undef: undefined,
          date: new Date('2024-01-01'),
          arr: [1, 2, 3],
          nested: { key: 'value' },
        }
        const cloned = deepClone(obj)

        expect(cloned).not.toBe(obj)
        expect(cloned.date).not.toBe(obj.date)
        expect(cloned.arr).not.toBe(obj.arr)
        expect(cloned.nested).not.toBe(obj.nested)
        expect(cloned).toEqual(obj)
      })
    })

    describe('immutability', () => {
      it('should not affect original object when cloned is modified', () => {
        const original = { a: { b: 1 } }
        const cloned = deepClone(original)
        ;(cloned as { a: { b: number } }).a.b = 999

        expect(original.a.b).toBe(1)
        expect(cloned.a.b).toBe(999)
      })

      it('should not affect original array when cloned is modified', () => {
        const original = [
          [1, 2],
          [3, 4],
        ]
        const cloned = deepClone(original)
        ;(cloned as number[][])[0][0] = 999

        expect(original[0][0]).toBe(1)
        expect(cloned[0][0]).toBe(999)
      })
    })
  })

  describe('sleep', () => {
    it('should resolve after specified duration', async () => {
      const start = Date.now()
      await sleep(50)
      const elapsed = Date.now() - start

      expect(elapsed).toBeGreaterThanOrEqual(45) // Allow some tolerance
    })

    it('should resolve immediately with 0ms', async () => {
      const start = Date.now()
      await sleep(0)
      const elapsed = Date.now() - start

      expect(elapsed).toBeLessThan(20) // Should be nearly instant
    })

    it('should return a promise', () => {
      const result = sleep(10)
      expect(result).toBeInstanceOf(Promise)
    })
  })

  describe('retry', () => {
    describe('success cases', () => {
      it('should return result on first successful attempt', async () => {
        const operation = vi.fn().mockResolvedValue('success')

        const result = await retry(operation)

        expect(result).toBe('success')
        expect(operation).toHaveBeenCalledTimes(1)
      })

      it('should return result on second attempt after first failure', async () => {
        const operation = vi
          .fn()
          .mockRejectedValueOnce(new Error('fail'))
          .mockResolvedValue('success')

        const result = await retry(operation, { baseDelayMs: 10 })

        expect(result).toBe('success')
        expect(operation).toHaveBeenCalledTimes(2)
      })

      it('should return result on third attempt after two failures', async () => {
        const operation = vi
          .fn()
          .mockRejectedValueOnce(new Error('fail 1'))
          .mockRejectedValueOnce(new Error('fail 2'))
          .mockResolvedValue('success')

        const result = await retry(operation, { baseDelayMs: 10 })

        expect(result).toBe('success')
        expect(operation).toHaveBeenCalledTimes(3)
      })
    })

    describe('retry exhaustion', () => {
      it('should throw last error after all attempts fail', async () => {
        const error = new Error('persistent failure')
        const operation = vi.fn().mockRejectedValue(error)

        await expect(retry(operation, { maxAttempts: 3, baseDelayMs: 10 })).rejects.toThrow(
          'persistent failure'
        )

        expect(operation).toHaveBeenCalledTimes(3)
      })

      it('should throw the last error when errors differ', async () => {
        const operation = vi
          .fn()
          .mockRejectedValueOnce(new Error('fail 1'))
          .mockRejectedValueOnce(new Error('fail 2'))
          .mockRejectedValueOnce(new Error('fail 3'))

        await expect(retry(operation, { maxAttempts: 3, baseDelayMs: 10 })).rejects.toThrow(
          'fail 3'
        )

        expect(operation).toHaveBeenCalledTimes(3)
      })

      it('should wrap non-Error throws in Error', async () => {
        const operation = vi.fn().mockRejectedValue('string error')

        await expect(retry(operation, { maxAttempts: 2, baseDelayMs: 10 })).rejects.toThrow(
          'string error'
        )

        expect(operation).toHaveBeenCalledTimes(2)
      })
    })

    describe('backoff behavior', () => {
      it('should apply exponential backoff between attempts', async () => {
        const operation = vi
          .fn()
          .mockRejectedValueOnce(new Error('fail'))
          .mockResolvedValue('success')

        const start = Date.now()
        await retry(operation, {
          maxAttempts: 2,
          baseDelayMs: 50,
          maxDelayMs: 1000,
        })
        const elapsed = Date.now() - start

        // First retry: baseDelay * 2^0 = 50ms
        expect(elapsed).toBeGreaterThanOrEqual(45)
        expect(operation).toHaveBeenCalledTimes(2)
      })

      it('should cap delay at maxDelayMs', async () => {
        const operation = vi
          .fn()
          .mockRejectedValueOnce(new Error('fail 1'))
          .mockRejectedValueOnce(new Error('fail 2'))
          .mockResolvedValue('success')

        const start = Date.now()
        await retry(operation, {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 50,
        })
        const elapsed = Date.now() - start

        // Without cap: 1000 * 2^0 + 1000 * 2^1 = 1000 + 2000 = 3000ms
        // With cap: 50 + 50 = 100ms
        expect(elapsed).toBeLessThan(200)
        expect(operation).toHaveBeenCalledTimes(3)
      })

      it('should not wait after last failed attempt', async () => {
        const operation = vi.fn().mockRejectedValue(new Error('fail'))

        const start = Date.now()
        await expect(
          retry(operation, {
            maxAttempts: 2,
            baseDelayMs: 50,
          })
        ).rejects.toThrow()
        const elapsed = Date.now() - start

        // Only one delay (after first attempt), no delay after second
        expect(elapsed).toBeLessThan(200)
      })
    })

    describe('options', () => {
      it('should use default options when none provided', async () => {
        const operation = vi.fn().mockResolvedValue('success')

        await retry(operation)

        expect(operation).toHaveBeenCalledTimes(1)
      })

      it('should respect custom maxAttempts', async () => {
        const operation = vi.fn().mockRejectedValue(new Error('fail'))

        await expect(retry(operation, { maxAttempts: 5, baseDelayMs: 10 })).rejects.toThrow()

        expect(operation).toHaveBeenCalledTimes(5)
      })

      it('should respect maxAttempts of 1', async () => {
        const operation = vi.fn().mockRejectedValue(new Error('fail'))

        await expect(retry(operation, { maxAttempts: 1 })).rejects.toThrow()

        expect(operation).toHaveBeenCalledTimes(1)
      })
    })

    describe('DEFAULT_RETRY_OPTIONS', () => {
      it('should have expected default values', () => {
        expect(DEFAULT_RETRY_OPTIONS).toEqual({
          maxAttempts: 3,
          baseDelayMs: 300,
          maxDelayMs: 3000,
        })
      })
    })
  })
})
