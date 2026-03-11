/**
 * Tool types for the Tianji AI system
 *
 * Defines the contract for tool definitions, invocations, and results.
 */

import type { ToolError } from './errors.js'

/**
 * JSON Schema for tool parameters
 */
export type JSONSchema = Record<string, unknown>

/**
 * Specification of a tool's interface
 */
export interface ToolSpec {
  name: string
  description: string
  parameters: JSONSchema
  permissions?: string[]
}

/**
 * A tool invocation request
 */
export interface ToolInvocation {
  toolCallId: string
  toolName: string
  args: unknown
}

/**
 * Result of a tool execution
 */
export interface ToolResult {
  toolCallId: string
  result: unknown
  error?: ToolError
}

// Re-export ToolError from errors module for convenience
export { ToolError } from './errors.js'
