/**
 * Error types for the Tianji AI system
 *
 * All errors extend TianjiError base class and are serializable
 * for cross-boundary communication.
 */

export type ErrorCategory =
  | 'provider'
  | 'tool'
  | 'policy'
  | 'timeout'
  | 'cancelled'
  | 'state'
  | 'internal'

export interface ErrorPlainObject {
  category: ErrorCategory
  code: string
  message: string
  cause?: ErrorPlainObject
}

/**
 * Base error class for all Tianji errors
 *
 * Provides serialization support via toPlainObject() method
 */
export class TianjiError extends Error {
  readonly category: ErrorCategory
  readonly code: string
  readonly cause?: TianjiError

  constructor(category: ErrorCategory, code: string, message: string, cause?: TianjiError) {
    super(message)
    this.name = 'TianjiError'
    this.category = category
    this.code = code
    this.message = message
    this.cause = cause
  }

  /**
   * Converts error to a plain object for serialization
   */
  toPlainObject(): ErrorPlainObject {
    return {
      category: this.category,
      code: this.code,
      message: this.message,
      cause: this.cause?.toPlainObject(),
    }
  }
}

/**
 * Error from LLM provider (OpenAI, Anthropic, Google, etc.)
 */
export class ProviderError extends TianjiError {
  constructor(code: string, message: string, cause?: TianjiError) {
    super('provider', code, message, cause)
    this.name = 'ProviderError'
  }
}

/**
 * Error from tool execution
 */
export class ToolError extends TianjiError {
  constructor(code: string, message: string, cause?: TianjiError) {
    super('tool', code, message, cause)
    this.name = 'ToolError'
  }
}

/**
 * Error from policy violation (rate limit, permission, etc.)
 */
export class PolicyError extends TianjiError {
  constructor(code: string, message: string, cause?: TianjiError) {
    super('policy', code, message, cause)
    this.name = 'PolicyError'
  }
}

/**
 * Error from operation timeout
 */
export class TimeoutError extends TianjiError {
  constructor(code: string, message: string, cause?: TianjiError) {
    super('timeout', code, message, cause)
    this.name = 'TimeoutError'
  }
}

/**
 * Error from operation cancellation
 */
export class CancelledError extends TianjiError {
  constructor(code: string, message: string, cause?: TianjiError) {
    super('cancelled', code, message, cause)
    this.name = 'CancelledError'
  }
}

/**
 * Error from invalid state transition or corrupted state
 */
export class StateError extends TianjiError {
  constructor(code: string, message: string, cause?: TianjiError) {
    super('state', code, message, cause)
    this.name = 'StateError'
  }
}

/**
 * Internal error (bug, unexpected condition, etc.)
 */
export class InternalError extends TianjiError {
  constructor(code: string, message: string, cause?: TianjiError) {
    super('internal', code, message, cause)
    this.name = 'InternalError'
  }
}

/**
 * Type guard for TianjiError
 */
export function isTianjiError(error: unknown): error is TianjiError {
  return error instanceof TianjiError
}

/**
 * Type guard for ErrorCategory
 */
export function isErrorCategory(value: unknown): value is ErrorCategory {
  const categories: ErrorCategory[] = [
    'provider',
    'tool',
    'policy',
    'timeout',
    'cancelled',
    'state',
    'internal',
  ]
  return typeof value === 'string' && categories.includes(value as ErrorCategory)
}

/**
 * Reconstructs an error from its plain object representation
 */
export function fromPlainObject(plain: ErrorPlainObject): TianjiError {
  const cause = plain.cause ? fromPlainObject(plain.cause) : undefined

  switch (plain.category) {
    case 'provider':
      return new ProviderError(plain.code, plain.message, cause)
    case 'tool':
      return new ToolError(plain.code, plain.message, cause)
    case 'policy':
      return new PolicyError(plain.code, plain.message, cause)
    case 'timeout':
      return new TimeoutError(plain.code, plain.message, cause)
    case 'cancelled':
      return new CancelledError(plain.code, plain.message, cause)
    case 'state':
      return new StateError(plain.code, plain.message, cause)
    case 'internal':
      return new InternalError(plain.code, plain.message, cause)
    default: {
      // Exhaustive check - this should never happen if ErrorCategory is properly typed
      const _exhaustive: never = plain.category
      throw new InternalError('unknown_category', `Unknown error category: ${String(_exhaustive)}`)
    }
  }
}
