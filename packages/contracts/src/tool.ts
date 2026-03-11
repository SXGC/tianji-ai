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

// ============================================================================
// JSON Schema Types
// ============================================================================

/**
 * Minimal JSON Schema type for tool parameter definitions.
 *
 * This is a simplified subset of JSON Schema sufficient for defining
 * tool parameters. The runtime (e.g., AI SDK) may support more features,
 * but this contract captures the essential structure.
 */
export interface JSONSchema {
	/** The JSON Schema version (typically "http://json-schema.org/draft-07/schema#") */
	$schema?: string
	/** Type of the schema (e.g., "object", "string", "array") */
	type: string
	/** Description of what this schema represents */
	description?: string
	/** Properties for object type schemas */
	properties?: Record<string, JSONSchema>
	/** List of required property names for object type */
	required?: string[]
	/** Schema for array items when type is "array" */
	items?: JSONSchema
	/** Allowed values for enum type */
	enum?: string[]
	/** Default value */
	default?: unknown
	/** Additional schema definitions to reference */
	definitions?: Record<string, JSONSchema>
	/** Reference to another schema definition */
	$ref?: string
	/** Additional properties allowed on the schema */
	[key: string]: unknown
}

// ============================================================================
// Tool Specification
// ============================================================================

/**
 * Specification for a tool that can be invoked by the AI.
 *
 * A ToolSpec defines:
 * - name: Unique identifier for the tool
 * - description: Human-readable description for the AI to understand the tool
 * - parameters: JSON Schema describing the expected arguments
 * - permissions: Optional list of permissions required to execute this tool
 *
 * @example
 * ```typescript
 * const readFileSpec: ToolSpec = {
 *   name: 'read_file',
 *   description: 'Read the contents of a file',
 *   parameters: {
 *     type: 'object',
 *     properties: {
 *       path: { type: 'string', description: 'File path to read' }
 *     },
 *     required: ['path']
 *   }
 * }
 * ```
 */
export interface ToolSpec {
	/** Unique name/identifier for the tool (e.g., "read_file", "execute_command") */
	name: string
	/** Human-readable description explaining what the tool does and when to use it */
	description: string
	/** JSON Schema describing the expected parameters/arguments */
	parameters: JSONSchema
	/** Optional list of permission names required to execute this tool */
	permissions?: string[]
}

// ============================================================================
// Tool Invocation
// ============================================================================

/**
 * Represents a tool invocation request from the AI.
 *
 * When the AI decides to call a tool, it creates a ToolInvocation with:
 * - toolCallId: Unique identifier for this specific invocation
 * - toolName: The name of the tool to invoke
 * - args: The arguments to pass to the tool
 *
 * @example
 * ```typescript
 * const invocation: ToolInvocation = {
 *   toolCallId: 'call_abc123',
 *   toolName: 'read_file',
 *   args: { path: '/src/index.ts' }
 * }
 * ```
 */
export interface ToolInvocation {
	/** Unique identifier for this specific tool call */
	toolCallId: string
	/** Name of the tool to invoke (must match a ToolSpec.name) */
	toolName: string
	/** Arguments to pass to the tool (should match the ToolSpec.parameters schema) */
	args: unknown
}

// ============================================================================
// Tool Result
// ============================================================================

/**
 * Result of a tool execution.
 *
 * A ToolResult contains:
 * - toolCallId: Matches the ToolInvocation.toolCallId
 * - result: The return value from the tool (if successful)
 * - error: Error information if the tool execution failed
 *
 * Note: Either result or error should be present, but both can be undefined
 * for edge cases (e.g., tool returns undefined with no error).
 *
 * @example
 * ```typescript
 * // Successful result
 * const successResult: ToolResult = {
 *   toolCallId: 'call_abc123',
 *   result: 'file contents here...'
 * }
 *
 * // Error result
 * const errorResult: ToolResult = {
 *   toolCallId: 'call_abc123',
 *   result: undefined,
 *   error: new ToolError('FILE_NOT_FOUND', 'File does not exist')
 * }
 * ```
 */
export interface ToolResult {
	/** Unique identifier matching the ToolInvocation this result corresponds to */
	toolCallId: string
	/** The return value from the tool execution (may be undefined) */
	result: unknown
	/** Error information if the tool execution failed */
	error?: ToolError
}
