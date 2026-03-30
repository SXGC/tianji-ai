/**
 * Tool types for tianji-ai
 *
 * Defines the contract for tools that can be invoked by the AI runtime.
 * Tools are defined by their specification (ToolSpec), invoked with
 * arguments (ToolInvocation), and return results (ToolResult).
 *
 * @module tool
 */

import type { ToolError } from './errors.js'

export interface JSONSchema {
  $schema?: string
  type: string
  description?: string
  properties?: Record<string, JSONSchema>
  required?: string[]
  items?: JSONSchema
  enum?: string[]
  default?: unknown
  definitions?: Record<string, JSONSchema>
  $ref?: string
  [key: string]: unknown
}

export interface ToolSpec {
  name: string
  description: string
  parameters: JSONSchema
  permissions?: string[]
}

export interface ToolInvocation {
  toolCallId: string
  toolName: string
  args: unknown
}

export interface ToolResult {
  toolCallId: string
  result: unknown
  error?: ToolError
}
