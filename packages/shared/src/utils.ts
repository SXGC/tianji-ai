/**
 * @tianji/shared - General-purpose utilities
 *
 * This module provides common utility functions used across tianji-ai packages.
 *
 * Note: This module MUST NOT depend on any internal @tianji/* packages.
 */

// ============================================================================
// deepClone - Deep clone for plain serializable data
// ============================================================================

/**
 * Deep clones a plain serializable value (objects, arrays, primitives).
 *
 * Handles:
 * - Primitives (number, string, boolean, null, undefined)
 * - Plain objects (including nested)
 * - Arrays (including nested)
 * - Date objects
 * - Map and Set instances
 *
 * Does NOT handle:
 * - Functions (copied by reference)
 * - Symbol keys/values
 * - Circular references (will throw)
 * - Class instances with internal state
 * - Buffer/TypedArray
 *
 * @param value - The value to clone
 * @returns A deep copy of the value
 */
export function deepClone<T>(value: T): T {
  // Handle primitives and null
  if (value === null || typeof value !== 'object') {
    return value
  }

  // Handle Date
  if (value instanceof Date) {
    return new Date(value.getTime()) as T
  }

  // Handle Map
  if (value instanceof Map) {
    const cloned = new Map()
    for (const [key, val] of value) {
      cloned.set(deepClone(key), deepClone(val))
    }
    return cloned as T
  }

  // Handle Set
  if (value instanceof Set) {
    const cloned = new Set()
    for (const item of value) {
      cloned.add(deepClone(item))
    }
    return cloned as T
  }

  // Handle Array
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T
  }

  // Handle plain object
  const cloned: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    cloned[key] = deepClone((value as Record<string, unknown>)[key])
  }
  return cloned as T
}

// ============================================================================
// sleep - Async delay helper
// ============================================================================

/**
 * Asynchronously waits for the specified duration.
 *
 * @param ms - The number of milliseconds to wait
 * @returns A promise that resolves after the specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// ============================================================================
// retry - Async operation retry with bounded backoff
// ============================================================================

/**
 * Options for retry behavior.
 */
export interface RetryOptions {
  /** Maximum number of attempts (including the initial attempt) */
  maxAttempts?: number
  /** Base delay in milliseconds for exponential backoff */
  baseDelayMs?: number
  /** Maximum delay in milliseconds for backoff cap */
  maxDelayMs?: number
}

/**
 * Default retry options.
 */
export const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 3000,
}

/**
 * Calculates the delay for a given attempt using exponential backoff.
 *
 * @param attempt - The current attempt number (0-indexed)
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay cap
 * @returns The calculated delay in milliseconds
 */
function calculateBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  // Exponential backoff: baseDelay * 2^attempt
  const delay = baseDelayMs * 2 ** attempt
  return Math.min(delay, maxDelayMs)
}

/**
 * Retries an async operation with exponential backoff.
 *
 * @param operation - The async operation to execute
 * @param options - Retry options
 * @returns The result of the operation if successful
 * @throws The last error if all attempts fail
 */
export async function retry<T>(operation: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...options,
  }

  let lastError: Error | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      // Don't wait after the last attempt
      if (attempt < maxAttempts - 1) {
        const delay = calculateBackoff(attempt, baseDelayMs, maxDelayMs)
        await sleep(delay)
      }
    }
  }

  // All attempts failed, throw the last error
  throw lastError
}
