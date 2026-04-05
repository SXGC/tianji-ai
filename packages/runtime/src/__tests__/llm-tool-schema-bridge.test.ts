import type { ToolSpec } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { ToolSchemaError, convertToolSpecs } from '../llm/tool-schema-bridge.js'

function makeToolSpec(name: string, description = 'Test tool'): ToolSpec {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string' },
      },
    },
  }
}

describe('convertToolSpecs', () => {
  it('converts a single tool', () => {
    const specs = [makeToolSpec('read_file', 'Read a file')]
    const result = convertToolSpecs(specs)

    expect(Object.keys(result)).toEqual(['read_file'])
    expect(result.read_file).toBeDefined()
    expect(result.read_file.description).toBe('Read a file')
    expect(result.read_file.parameters).toBeDefined()
  })

  it('converts multiple tools', () => {
    const specs = [makeToolSpec('tool_a'), makeToolSpec('tool_b'), makeToolSpec('tool_c')]
    const result = convertToolSpecs(specs)

    expect(Object.keys(result)).toEqual(['tool_a', 'tool_b', 'tool_c'])
  })

  it('throws ToolSchemaError on duplicate names', () => {
    const specs = [makeToolSpec('duplicate'), makeToolSpec('duplicate')]

    expect(() => convertToolSpecs(specs)).toThrow(ToolSchemaError)
    try {
      convertToolSpecs(specs)
    } catch (error) {
      expect(error).toBeInstanceOf(ToolSchemaError)
      expect((error as ToolSchemaError).cause).toBe('duplicate_name')
      expect((error as ToolSchemaError).message).toContain('duplicate')
    }
  })

  it('returns empty record for empty array', () => {
    const result = convertToolSpecs([])

    expect(result).toEqual({})
  })
})
