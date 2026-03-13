/**
 * Tool schema bridge - converts ToolSpec to AI SDK tool definitions
 *
 * This module provides internal conversion from project-owned ToolSpec
 * to AI SDK-compatible tool schema objects. Provider adapters will
 * import this directly (not via public barrel).
 *
 * @module tool-schema-bridge
 */

import type { ToolSpec } from '@tianji/contracts'
import type { Tool } from 'ai'
import { jsonSchema } from 'ai'

// ============================================================================
// ConversionError
// ============================================================================

/**
 * Custom error for tool schema conversion failures
 */
export class ToolSchemaError extends Error {
  constructor(
    message: string,
    public readonly cause?: 'duplicate_name' | 'invalid_schema'
  ) {
    super(message)
    this.name = 'ToolSchemaError'
  }
}

// ============================================================================
// ToolSpec → AI SDK Tool Conversion
// ============================================================================

/**
 * Convert a single ToolSpec into an AI SDK Tool definition.
 *
 * The conversion maps:
 * - ToolSpec.name → Tool key (handled by convertToolSpecs, not here)
 * - ToolSpec.description → Tool.description
 * - ToolSpec.parameters (JSONSchema) → Tool.parameters (via jsonSchema)
 * - ToolSpec.permissions → ignored (not part of AI SDK Tool)
 *
 * Note: The returned Tool has no execute function. Provider adapters
 * will add execution logic as needed.
 */
function convertToolSpec(spec: ToolSpec): Tool {
  // Convert our JSONSchema to AI SDK Schema using jsonSchema function
  // Our JSONSchema type is compatible with JSONSchema7 used by AI SDK
  const parameters = jsonSchema(spec.parameters as Parameters<typeof jsonSchema>[0])

  return {
    parameters,
    description: spec.description,
    // No execute function - provider adapters will add this
  }
}

/**
 * Convert one or more ToolSpec values into AI SDK-compatible tool definitions.
 *
 * Returns a Record keyed by tool name, where each value is an AI SDK Tool
 * with parameters and description.
 *
 * @param specs - Array of ToolSpec to convert
 * @returns Record mapping tool name to AI SDK Tool definition
 * @throws ToolSchemaError if duplicate tool names are detected
 *
 * @example
 * ```typescript
 * const specs: ToolSpec[] = [
 *   {
 *     name: 'read_file',
 *     description: 'Read a file',
 *     parameters: { type: 'object', properties: { path: { type: 'string' } } }
 *   }
 * ]
 *
 * const tools = convertToolSpecs(specs)
 * // tools = { read_file: { parameters: Schema, description: 'Read a file' } }
 * ```
 */
export function convertToolSpecs(specs: readonly ToolSpec[]): Record<string, Tool> {
  const result: Record<string, Tool> = {}
  const seenNames = new Set<string>()

  for (const spec of specs) {
    // Check for duplicate tool names
    if (seenNames.has(spec.name)) {
      throw new ToolSchemaError(
        `Duplicate tool name detected: "${spec.name}". Each tool must have a unique name.`,
        'duplicate_name'
      )
    }

    seenNames.add(spec.name)
    result[spec.name] = convertToolSpec(spec)
  }

  return result
}
