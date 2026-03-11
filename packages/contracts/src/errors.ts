/**
 * Error types for tianji-ai
 *
 * All errors extend TianjiError base class and provide:
 * - code: Machine-readable error code
 * - message: Human-readable error message
 * - cause?: Original error that caused this error
 * - category: Error category for classification
 */

/**
 * Error categories for classification
 */
export type ErrorCategory =
	| 'provider'
	| 'tool'
	| 'policy'
	| 'timeout'
	| 'cancelled'
	| 'state'
	| 'internal'

/**
 * Base error interface for serialization
 */
export interface ErrorPlainObject {
	readonly name: string
	readonly category: ErrorCategory
	readonly code: string
	readonly message: string
	readonly cause?: ErrorPlainObject
}

/**
 * Base class for all tianji-ai errors
 *
 * All custom errors should extend this class to ensure:
 * - Consistent serialization via toPlainObject()
 * - Proper instanceof Error behavior
 * - Error cause chain preservation
 */
export class TianjiError extends Error {
	public readonly category: ErrorCategory
	public readonly code: string
	public override readonly cause?: Error

	constructor(
		category: ErrorCategory,
		code: string,
		message: string,
		options?: { cause?: Error },
	) {
		super(message, options)
		this.name = 'TianjiError'
		this.category = category
		this.code = code
		this.cause = options?.cause
	}

	/**
	 * Serialize error to plain object for logging/transport
	 */
	toPlainObject(): ErrorPlainObject {
		return {
			name: this.name,
			category: this.category,
			code: this.code,
			message: this.message,
			cause: this.cause
				? this.cause instanceof TianjiError
					? this.cause.toPlainObject()
					: {
							name: this.cause.name,
							category: 'internal' as ErrorCategory,
							code: this.cause.name,
							message: this.cause.message,
						}
				: undefined,
		}
	}
}

/**
 * Provider-related errors (LLM API failures, rate limits, etc.)
 */
export class ProviderError extends TianjiError {
	constructor(
		code: string,
		message: string,
		options?: { cause?: Error },
	) {
		super('provider', code, message, options)
		this.name = 'ProviderError'
	}
}

/**
 * Tool execution errors
 */
export class ToolError extends TianjiError {
	constructor(
		code: string,
		message: string,
		options?: { cause?: Error },
	) {
		super('tool', code, message, options)
		this.name = 'ToolError'
	}
}

/**
 * Policy violation errors
 */
export class PolicyError extends TianjiError {
	constructor(
		code: string,
		message: string,
		options?: { cause?: Error },
	) {
		super('policy', code, message, options)
		this.name = 'PolicyError'
	}
}

/**
 * Timeout errors
 */
export class TimeoutError extends TianjiError {
	constructor(
		code: string,
		message: string,
		options?: { cause?: Error },
	) {
		super('timeout', code, message, options)
		this.name = 'TimeoutError'
	}
}

/**
 * Cancellation errors
 */
export class CancelledError extends TianjiError {
	constructor(
		code: string,
		message: string,
		options?: { cause?: Error },
	) {
		super('cancelled', code, message, options)
		this.name = 'CancelledError'
	}
}
