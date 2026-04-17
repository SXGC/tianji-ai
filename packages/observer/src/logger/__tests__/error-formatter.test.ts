import { describe, expect, it } from 'vitest'

import { errorToLogData } from '../error-formatter.js'

describe('errorToLogData', () => {
  it('returns name / message / stack for Error instances', () => {
    const err = new Error('boom')
    const data = errorToLogData(err)
    expect(data.name).toBe('Error')
    expect(data.message).toBe('boom')
    expect(typeof data.stack).toBe('string')
    expect(data.stack).toContain('boom')
  })

  it('preserves custom error subclass name', () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message)
        this.name = 'CustomError'
      }
    }
    const data = errorToLogData(new CustomError('oops'))
    expect(data.name).toBe('CustomError')
  })

  it('recursively expands cause chain', () => {
    const root = new Error('root')
    const mid = new Error('mid', { cause: root })
    const top = new Error('top', { cause: mid })

    const data = errorToLogData(top)
    const causeMid = data.cause as Record<string, unknown>
    const causeRoot = causeMid.cause as Record<string, unknown>

    expect(data.message).toBe('top')
    expect(causeMid.message).toBe('mid')
    expect(causeRoot.message).toBe('root')
    expect(causeRoot.cause).toBeUndefined()
  })

  it('stops recursion at maxDepth to avoid infinite loops', () => {
    const a = new Error('a')
    const b = new Error('b', { cause: a })
    ;(a as unknown as { cause: Error }).cause = b

    const data = errorToLogData(a, { maxDepth: 2 })
    expect(data.message).toBe('a')
    const firstCause = data.cause as Record<string, unknown>
    expect(firstCause.message).toBe('b')
    expect(firstCause.cause).toBe('[truncated: maxDepth reached]')
  })

  it('returns string fallback for non-Error primitives', () => {
    expect(errorToLogData('plain string')).toEqual({ message: 'plain string' })
    expect(errorToLogData(42)).toEqual({ message: '42' })
    expect(errorToLogData(null)).toEqual({ message: 'null' })
    expect(errorToLogData(undefined)).toEqual({ message: 'undefined' })
  })

  it('json-serializes plain object rejections', () => {
    const data = errorToLogData({ code: 'ECONNREFUSED', port: 3000 })
    expect(data.message).toContain('ECONNREFUSED')
    expect(data.message).toContain('3000')
  })
})
