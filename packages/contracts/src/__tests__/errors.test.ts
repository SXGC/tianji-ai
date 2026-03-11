import { describe, expect, it } from 'vitest'
import {
  CancelledError,
  type ErrorCategory,
  type ErrorPlainObject,
  InternalError,
  PolicyError,
  ProviderError,
  StateError,
  TianjiError,
  TimeoutError,
  ToolError,
  fromPlainObject,
  isErrorCategory,
  isTianjiError,
} from '../index.js'

describe('TianjiError', () => {
  it('creates base error with all properties', () => {
    const error = new TianjiError('internal', 'TEST_CODE', 'Test message')
    expect(error.category).toBe('internal')
    expect(error.code).toBe('TEST_CODE')
    expect(error.message).toBe('Test message')
    expect(error.name).toBe('TianjiError')
    expect(error.cause).toBeUndefined()
  })

  it('creates base error with cause', () => {
    const cause = new TianjiError('provider', 'CAUSE_CODE', 'Cause message')
    const error = new TianjiError('internal', 'TEST_CODE', 'Test message', cause)
    expect(error.cause).toBe(cause)
  })

  it('serializes to plain object', () => {
    const cause = new ProviderError('CAUSE_CODE', 'Cause message')
    const error = new TianjiError('internal', 'TEST_CODE', 'Test message', cause)
    const plain = error.toPlainObject()
    expect(plain).toEqual({
      category: 'internal',
      code: 'TEST_CODE',
      message: 'Test message',
      cause: {
        category: 'provider',
        code: 'CAUSE_CODE',
        message: 'Cause message',
        cause: undefined,
      },
    })
  })
})

describe('ProviderError', () => {
  it('creates provider error with correct category', () => {
    const error = new ProviderError('RATE_LIMIT', 'Rate limit exceeded')
    expect(error.category).toBe('provider')
    expect(error.code).toBe('RATE_LIMIT')
    expect(error.name).toBe('ProviderError')
  })
})

describe('ToolError', () => {
  it('creates tool error with correct category', () => {
    const error = new ToolError('EXECUTION_FAILED', 'Tool execution failed')
    expect(error.category).toBe('tool')
    expect(error.code).toBe('EXECUTION_FAILED')
    expect(error.name).toBe('ToolError')
  })
})

describe('PolicyError', () => {
  it('creates policy error with correct category', () => {
    const error = new PolicyError('PERMISSION_DENIED', 'Permission denied')
    expect(error.category).toBe('policy')
    expect(error.code).toBe('PERMISSION_DENIED')
    expect(error.name).toBe('PolicyError')
  })
})

describe('TimeoutError', () => {
  it('creates timeout error with correct category', () => {
    const error = new TimeoutError('OPERATION_TIMEOUT', 'Operation timed out')
    expect(error.category).toBe('timeout')
    expect(error.code).toBe('OPERATION_TIMEOUT')
    expect(error.name).toBe('TimeoutError')
  })
})

describe('CancelledError', () => {
  it('creates cancelled error with correct category', () => {
    const error = new CancelledError('USER_CANCELLED', 'User cancelled operation')
    expect(error.category).toBe('cancelled')
    expect(error.code).toBe('USER_CANCELLED')
    expect(error.name).toBe('CancelledError')
  })
})

describe('StateError', () => {
  it('creates state error with correct category', () => {
    const error = new StateError('INVALID_STATE', 'Invalid state transition')
    expect(error.category).toBe('state')
    expect(error.code).toBe('INVALID_STATE')
    expect(error.name).toBe('StateError')
  })
})

describe('InternalError', () => {
  it('creates internal error with correct category', () => {
    const error = new InternalError('UNEXPECTED', 'Unexpected error')
    expect(error.category).toBe('internal')
    expect(error.code).toBe('UNEXPECTED')
    expect(error.name).toBe('InternalError')
  })
})

describe('isTianjiError', () => {
  it('returns true for TianjiError instances', () => {
    const error = new ProviderError('TEST', 'Test')
    expect(isTianjiError(error)).toBe(true)
  })

  it('returns true for subclass instances', () => {
    const error = new ToolError('TEST', 'Test')
    expect(isTianjiError(error)).toBe(true)
  })

  it('returns false for standard Error', () => {
    const error = new Error('Test')
    expect(isTianjiError(error)).toBe(false)
  })

  it('returns false for non-error values', () => {
    expect(isTianjiError(null)).toBe(false)
    expect(isTianjiError(undefined)).toBe(false)
    expect(isTianjiError('error')).toBe(false)
    expect(isTianjiError(123)).toBe(false)
  })
})

describe('isErrorCategory', () => {
  it('returns true for valid categories', () => {
    const categories: ErrorCategory[] = [
      'provider',
      'tool',
      'policy',
      'timeout',
      'cancelled',
      'state',
      'internal',
    ]
    for (const category of categories) {
      expect(isErrorCategory(category)).toBe(true)
    }
  })

  it('returns false for invalid categories', () => {
    expect(isErrorCategory('unknown')).toBe(false)
    expect(isErrorCategory('')).toBe(false)
    expect(isErrorCategory(null)).toBe(false)
    expect(isErrorCategory(undefined)).toBe(false)
    expect(isErrorCategory(123)).toBe(false)
  })
})

describe('fromPlainObject', () => {
  it('reconstructs ProviderError', () => {
    const plain: ErrorPlainObject = {
      category: 'provider',
      code: 'TEST',
      message: 'Test message',
    }
    const error = fromPlainObject(plain)
    expect(error).toBeInstanceOf(ProviderError)
    expect(error.code).toBe('TEST')
    expect(error.message).toBe('Test message')
  })

  it('reconstructs ToolError', () => {
    const plain: ErrorPlainObject = {
      category: 'tool',
      code: 'EXECUTION_FAILED',
      message: 'Tool failed',
    }
    const error = fromPlainObject(plain)
    expect(error).toBeInstanceOf(ToolError)
    expect(error.code).toBe('EXECUTION_FAILED')
  })

  it('reconstructs PolicyError', () => {
    const plain: ErrorPlainObject = {
      category: 'policy',
      code: 'DENIED',
      message: 'Policy denied',
    }
    const error = fromPlainObject(plain)
    expect(error).toBeInstanceOf(PolicyError)
  })

  it('reconstructs TimeoutError', () => {
    const plain: ErrorPlainObject = {
      category: 'timeout',
      code: 'TIMEOUT',
      message: 'Timed out',
    }
    const error = fromPlainObject(plain)
    expect(error).toBeInstanceOf(TimeoutError)
  })

  it('reconstructs CancelledError', () => {
    const plain: ErrorPlainObject = {
      category: 'cancelled',
      code: 'CANCELLED',
      message: 'Cancelled',
    }
    const error = fromPlainObject(plain)
    expect(error).toBeInstanceOf(CancelledError)
  })

  it('reconstructs StateError', () => {
    const plain: ErrorPlainObject = {
      category: 'state',
      code: 'INVALID',
      message: 'Invalid state',
    }
    const error = fromPlainObject(plain)
    expect(error).toBeInstanceOf(StateError)
  })

  it('reconstructs InternalError', () => {
    const plain: ErrorPlainObject = {
      category: 'internal',
      code: 'BUG',
      message: 'Internal bug',
    }
    const error = fromPlainObject(plain)
    expect(error).toBeInstanceOf(InternalError)
  })

  it('reconstructs nested cause chain', () => {
    const plain: ErrorPlainObject = {
      category: 'tool',
      code: 'OUTER',
      message: 'Outer error',
      cause: {
        category: 'provider',
        code: 'INNER',
        message: 'Inner error',
      },
    }
    const error = fromPlainObject(plain)
    expect(error).toBeInstanceOf(ToolError)
    expect(error.cause).toBeInstanceOf(ProviderError)
    expect(error.cause?.code).toBe('INNER')
  })
})

describe('serialization roundtrip', () => {
  it('preserves all error properties through serialize/deserialize', () => {
    const original = new ToolError(
      'TEST_CODE',
      'Test message',
      new ProviderError('CAUSE_CODE', 'Cause message'),
    )
    const plain = original.toPlainObject()
    const reconstructed = fromPlainObject(plain)

    expect(reconstructed.category).toBe(original.category)
    expect(reconstructed.code).toBe(original.code)
    expect(reconstructed.message).toBe(original.message)
    expect(reconstructed.cause?.category).toBe(original.cause?.category)
    expect(reconstructed.cause?.code).toBe(original.cause?.code)
    expect(reconstructed.cause?.message).toBe(original.cause?.message)
  })

  it('produces valid JSON', () => {
    const error = new ToolError('TEST', 'Test message')
    const plain = error.toPlainObject()
    const json = JSON.stringify(plain)
    const parsed = JSON.parse(json) as ErrorPlainObject
    expect(parsed.category).toBe('tool')
    expect(parsed.code).toBe('TEST')
    expect(parsed.message).toBe('Test message')
  })
})
