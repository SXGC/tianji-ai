/**
 * Branded identifier types for tianji-ai.
 *
 * These types use TypeScript's branded type pattern to prevent accidental
 * mixing of different identifier types (SessionId, ThreadId, RunId).
 * While they are strings at runtime, TypeScript's type system enforces
 * correct usage at compile time.
 *
 * @module identifiers
 */

// ============================================================================
// Branded Types
// ============================================================================

/**
 * Unique identifier for a Session.
 * A Session represents a conversation context that can contain multiple threads.
 */
export type SessionId = string & { readonly __brand: unique symbol }

/**
 * Unique identifier for a Thread.
 * A Thread represents a single conversation within a session.
 */
export type ThreadId = string & { readonly __brand: unique symbol }

/**
 * Unique identifier for a Run.
 * A Run represents a single execution/inference within a thread.
 */
export type RunId = string & { readonly __brand: unique symbol }

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a SessionId from a string.
 * @param value - The string value to brand as a SessionId
 * @returns A SessionId branded string
 */
export function createSessionId(value: string): SessionId {
  return value as SessionId
}

/**
 * Creates a ThreadId from a string.
 * @param value - The string value to brand as a ThreadId
 * @returns A ThreadId branded string
 */
export function createThreadId(value: string): ThreadId {
  return value as ThreadId
}

/**
 * Creates a RunId from a string.
 * @param value - The string value to brand as a RunId
 * @returns A RunId branded string
 */
export function createRunId(value: string): RunId {
  return value as RunId
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check if a value is a SessionId.
 * Note: At runtime, this only verifies the value is a string.
 * The branding is a compile-time construct.
 * @param value - The value to check
 * @returns True if the value is a string (branded as SessionId at compile time)
 */
export function isSessionId(value: unknown): value is SessionId {
  return typeof value === 'string'
}

/**
 * Type guard to check if a value is a ThreadId.
 * Note: At runtime, this only verifies the value is a string.
 * The branding is a compile-time construct.
 * @param value - The value to check
 * @returns True if the value is a string (branded as ThreadId at compile time)
 */
export function isThreadId(value: unknown): value is ThreadId {
  return typeof value === 'string'
}

/**
 * Type guard to check if a value is a RunId.
 * Note: At runtime, this only verifies the value is a string.
 * The branding is a compile-time construct.
 * @param value - The value to check
 * @returns True if the value is a string (branded as RunId at compile time)
 */
export function isRunId(value: unknown): value is RunId {
  return typeof value === 'string'
}
