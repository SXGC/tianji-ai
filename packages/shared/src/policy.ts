/**
 * Execution Policy Types
 *
 * Defines policies for controlling execution behavior including retry strategies,
 * tool execution limits, and filesystem path restrictions.
 *
 * @module policy
 */

export interface RetryPolicy {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export interface ToolPolicy {
  timeoutMs: number
  maxConcurrency: number
  allowDestructive: boolean
}

export interface PathPolicy {
  forbidDirectories: string[]
  filenameDenyPatterns: string[]
}

export interface ExecutionPolicy {
  retry: RetryPolicy
  tool: ToolPolicy
  toolPath: PathPolicy
}

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
