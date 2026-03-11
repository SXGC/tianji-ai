/**
 * Tool schema bridge for AI SDK.
 * Converts ToolSpec from @tianji/contracts into AI SDK-compatible tool schema.
 */
import type { ToolSpec } from '@tianji/contracts'
import { jsonSchema } from 'ai'

/**
 * Convert a ToolSpec to an AI SDK-compatible tool definition.
 * The result can be used with generateText, streamText, etc.
 *
 * @param spec - The ToolSpec to convert
 * @returns An object with description and parameters compatible with AI SDK Tool
 */
export function toolSpecToAiSdkTool(spec: ToolSpec): {
  description: string
  parameters: ReturnType<typeof jsonSchema>
} {
  return {
    description: spec.description,
    parameters: jsonSchema(spec.parameters),
  }
}
