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

describe('errorToLogData hardening', () => {
  it('falls back gracefully when stack getter throws', () => {
    const err = new Error('boom')
    Object.defineProperty(err, 'stack', {
      get() {
        throw new Error('stack getter failed')
      },
    })

    const data = errorToLogData(err)
    expect(data.message).toBe('boom')
    expect(typeof data.stack).toBe('string')
    expect(data.stack).toContain('stack unavailable')
  })

  it('falls back gracefully when cause getter throws', () => {
    const err = new Error('boom')
    Object.defineProperty(err, 'cause', {
      get() {
        throw new Error('cause getter failed')
      },
    })

    const data = errorToLogData(err)
    expect(data.cause).toBe('[cause unavailable]')
  })

  it('coerces non-string name and message to string', () => {
    const err = new Error('orig')
    ;(err as unknown as { name: unknown }).name = 123
    ;(err as unknown as { message: unknown }).message = { foo: 'bar' }

    const data = errorToLogData(err)
    expect(data.name).toBe('123')
    expect(typeof data.message).toBe('string')
  })

  it('redacts sensitive keys from plain-object cause when provided', () => {
    const err = new Error('boom', { cause: { apiKey: 'secret', other: 'ok' } })
    const data = errorToLogData(err, { sensitiveKeys: new Set(['apiKey']) })
    const cause = data.cause as Record<string, unknown>
    expect(cause.message).not.toContain('secret')
    expect(cause.message).toContain('ok')
  })

  it('serializes plain-object cause without redaction when no sensitiveKeys given', () => {
    const err = new Error('boom', { cause: { apiKey: 'leaked' } })
    const data = errorToLogData(err)
    const cause = data.cause as Record<string, unknown>
    expect(cause.message).toContain('leaked')
  })
})
