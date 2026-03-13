/**
 * Execution Policy Types
 *
 * Defines policies for controlling execution behavior including retry strategies,
 * tool execution limits, and filesystem path restrictions.
 *
 * @module policy
 */

/**
 * Retry policy for transient failures
 *
 * Controls exponential backoff retry behavior for operations that may fail temporarily.
 */
export interface RetryPolicy {
  /** Maximum number of retry attempts (including the initial attempt) */
  maxAttempts: number
  /** Base delay in milliseconds for exponential backoff */
  baseDelayMs: number
  /** Maximum delay cap in milliseconds for exponential backoff */
  maxDelayMs: number
}

/**
 * Policy for tool execution constraints
 *
 * Controls timeouts, concurrency limits, and destructive operation permissions for tools.
 */
export interface ToolPolicy {
  /** Timeout in milliseconds for individual tool execution */
  timeoutMs: number
  /** Maximum number of tools that can execute concurrently */
  maxConcurrency: number
  /** Whether destructive operations (e.g., file deletion) are allowed */
  allowDestructive: boolean
}

/**
 * Policy for filesystem path restrictions
 *
 * Controls which directories and file patterns are forbidden for tool access.
 */
export interface PathPolicy {
  /** List of directory paths that tools are forbidden from accessing */
  forbidDirectories: string[]
  /** List of regex patterns for filenames that are forbidden */
  filenameDenyPatterns: string[]
}

/**
 * Complete execution policy configuration
 *
 * Aggregates all policy types into a single configuration object.
 */
export interface ExecutionPolicy {
  /** Retry policy for transient failures */
  retry: RetryPolicy
  /** Tool execution constraints */
  tool: ToolPolicy
  /** Filesystem path restrictions */
  toolPath: PathPolicy
}

/**
 * Default execution policy with reasonable values for most use cases
 *
 * Default values are chosen to be safe and production-ready:
 * - Retry: 3 attempts with 1-30 second exponential backoff
 * - Tool: 30 second timeout, 5 concurrent tools, no destructive operations
 * - Path: No restrictions by default (can be configured for security)
 */
export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  retry: {
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  },
  tool: {
    timeoutMs: 30000,
    maxConcurrency: 5,
    allowDestructive: false,
  },
  toolPath: {
    forbidDirectories: [],
    filenameDenyPatterns: [],
  },
}
