import { describe, expect, it } from 'vitest'
import {
  CancelledError,
  type ErrorCategory,
  type ErrorPlainObject,
  PolicyError,
  ProviderError,
  TianjiError,
  TimeoutError,
  ToolError,
} from '../errors.js'

describe('TianjiError', () => {
  describe('constructor', () => {
    it('should create instance with required fields', () => {
      const error = new TianjiError('internal', 'TEST_CODE', 'Test message')
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(TianjiError)
      expect(error.name).toBe('TianjiError')
      expect(error.category).toBe('internal')
      expect(error.code).toBe('TEST_CODE')
      expect(error.message).toBe('Test message')
      expect(error.cause).toBeUndefined()
    })

    it('should create instance with cause', () => {
      const cause = new Error('Original error')
      const error = new TianjiError('state', 'CHAIN_ERROR', 'Chained error', { cause })
      expect(error.cause).toBe(cause)
    })
  })

  describe('toPlainObject', () => {
    it('should serialize to plain object', () => {
      const error = new TianjiError('internal', 'CODE', 'Message')
      const plain = error.toPlainObject()
      expect(plain).toEqual({
        name: 'TianjiError',
        category: 'internal',
        code: 'CODE',
        message: 'Message',
        cause: undefined,
      })
    })

    it('should serialize with TianjiError cause', () => {
      const cause = new TianjiError('provider', 'CAUSE_CODE', 'Cause message')
      const error = new TianjiError('tool', 'PARENT_CODE', 'Parent message', { cause })
      const plain = error.toPlainObject()
      expect(plain.cause).toEqual({
        name: 'TianjiError',
        category: 'provider',
        code: 'CAUSE_CODE',
        message: 'Cause message',
        cause: undefined,
      })
    })

    it('should serialize with native Error cause', () => {
      const cause = new Error('Native error')
      const error = new TianjiError('timeout', 'TIMEOUT_CODE', 'Timeout', { cause })
      const plain = error.toPlainObject()
      expect(plain.cause).toEqual({
        name: 'Error',
        category: 'internal',
        code: 'Error',
        message: 'Native error',
      })
    })

    it('should be JSON serializable', () => {
      const error = new ProviderError('API_ERROR', 'API failed')
      const plain = error.toPlainObject()
      const json = JSON.stringify(plain)
      expect(() => JSON.parse(json)).not.toThrow()
      const parsed = JSON.parse(json) as ErrorPlainObject
      expect(parsed.category).toBe('provider')
      expect(parsed.code).toBe('API_ERROR')
    })
  })
})

describe('ProviderError', () => {
  it('should have provider category', () => {
    const error = new ProviderError('RATE_LIMIT', 'Rate limit exceeded')
    expect(error.category).toBe('provider')
    expect(error.name).toBe('ProviderError')
    expect(error).toBeInstanceOf(TianjiError)
    expect(error).toBeInstanceOf(Error)
  })

  it('should support cause chain', () => {
    const cause = new Error('Network error')
    const error = new ProviderError('NETWORK_ERROR', 'Network failed', { cause })
    expect(error.cause).toBe(cause)
  })
})

describe('ToolError', () => {
  it('should have tool category', () => {
    const error = new ToolError('INVALID_ARGS', 'Invalid arguments')
    expect(error.category).toBe('tool')
    expect(error.name).toBe('ToolError')
    expect(error).toBeInstanceOf(TianjiError)
    expect(error).toBeInstanceOf(Error)
  })

  it('should support cause chain', () => {
    const cause = new ToolError('SUB_ERROR', 'Sub tool failed')
    const error = new ToolError('TOOL_FAILED', 'Tool execution failed', { cause })
    expect(error.cause).toBe(cause)
    expect(error.cause).toBeInstanceOf(ToolError)
  })
})

describe('PolicyError', () => {
  it('should have policy category', () => {
    const error = new PolicyError('FORBIDDEN_PATH', 'Path access denied')
    expect(error.category).toBe('policy')
    expect(error.name).toBe('PolicyError')
    expect(error).toBeInstanceOf(TianjiError)
    expect(error).toBeInstanceOf(Error)
  })
})

describe('TimeoutError', () => {
  it('should have timeout category', () => {
    const error = new TimeoutError('EXECUTION_TIMEOUT', 'Execution timed out')
    expect(error.category).toBe('timeout')
    expect(error.name).toBe('TimeoutError')
    expect(error).toBeInstanceOf(TianjiError)
    expect(error).toBeInstanceOf(Error)
  })
})

describe('CancelledError', () => {
  it('should have cancelled category', () => {
    const error = new CancelledError('USER_CANCEL', 'User cancelled operation')
    expect(error.category).toBe('cancelled')
    expect(error.name).toBe('CancelledError')
    expect(error).toBeInstanceOf(TianjiError)
    expect(error).toBeInstanceOf(Error)
  })
})

describe('ErrorCategory type', () => {
  it('should accept all valid categories', () => {
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
      const error = new TianjiError(category, 'CODE', 'Message')
      expect(error.category).toBe(category)
    }
  })
})

describe('Error serialization completeness', () => {
  it('should preserve complete error chain', () => {
    const rootCause = new Error('Root cause')
    const toolError = new ToolError('TOOL_FAIL', 'Tool failed', { cause: rootCause })
    const providerError = new ProviderError('PROVIDER_FAIL', 'Provider failed', {
      cause: toolError,
    })
    const plain = providerError.toPlainObject()

    expect(plain.name).toBe('ProviderError')
    expect(plain.category).toBe('provider')
    expect(plain.code).toBe('PROVIDER_FAIL')
    expect(plain.message).toBe('Provider failed')
    expect(plain.cause?.name).toBe('ToolError')
    expect(plain.cause?.category).toBe('tool')
    expect(plain.cause?.code).toBe('TOOL_FAIL')
    expect(plain.cause?.cause?.name).toBe('Error')
    expect(plain.cause?.cause?.category).toBe('internal')
  })

  it('should produce deterministic JSON output', () => {
    const error = new PolicyError('DENIED', 'Access denied')
    const plain1 = error.toPlainObject()
    const plain2 = error.toPlainObject()
    expect(JSON.stringify(plain1)).toBe(JSON.stringify(plain2))
  })
})
