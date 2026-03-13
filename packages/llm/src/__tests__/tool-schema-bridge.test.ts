/**
 * Tests for tool-schema-bridge
 */

import type { ToolSpec } from '@tianji/contracts'
import { describe, expect, it } from 'vitest'
import { ToolSchemaError, convertToolSpecs } from '../tool-schema-bridge.js'

describe('tool-schema-bridge', () => {
  describe('convertToolSpecs', () => {
    describe('single tool conversion', () => {
      it('should convert a single ToolSpec to AI SDK tool', () => {
        const spec: ToolSpec = {
          name: 'read_file',
          description: 'Read the contents of a file',
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'File path to read',
              },
            },
            required: ['path'],
          },
        }

        const tools = convertToolSpecs([spec])

        expect(tools).toHaveProperty('read_file')
        expect(tools.read_file.description).toBe('Read the contents of a file')
        expect(tools.read_file.parameters).toBeDefined()
        expect(tools.read_file.parameters.jsonSchema).toMatchObject({
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path to read',
            },
          },
          required: ['path'],
        })
      })

      it('should preserve tool description', () => {
        const spec: ToolSpec = {
          name: 'execute_command',
          description: 'Execute a shell command with safety checks',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string' },
            },
            required: ['command'],
          },
        }

        const tools = convertToolSpecs([spec])

        expect(tools.execute_command.description).toBe('Execute a shell command with safety checks')
      })

      it('should preserve parameter schema semantics', () => {
        const spec: ToolSpec = {
          name: 'search_files',
          description: 'Search for files',
          parameters: {
            type: 'object',
            properties: {
              pattern: {
                type: 'string',
                description: 'Glob pattern to match',
              },
              maxResults: {
                type: 'number',
                description: 'Maximum number of results',
                default: 100,
              },
              includeHidden: {
                type: 'boolean',
                description: 'Include hidden files',
              },
            },
            required: ['pattern'],
          },
        }

        const tools = convertToolSpecs([spec])
        const schema = tools.search_files.parameters.jsonSchema

        expect(schema.type).toBe('object')
        expect(schema.properties).toHaveProperty('pattern')
        expect(schema.properties).toHaveProperty('maxResults')
        expect(schema.properties).toHaveProperty('includeHidden')
        expect(schema.required).toContain('pattern')

        // Check nested property schemas
        expect((schema.properties?.pattern as { type: string }).type).toBe('string')
        expect((schema.properties?.maxResults as { default: number }).default).toBe(100)
        expect((schema.properties?.includeHidden as { type: string }).type).toBe('boolean')
      })

      it('should handle tools with permissions field', () => {
        const spec: ToolSpec = {
          name: 'delete_file',
          description: 'Delete a file',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
          permissions: ['fs:write'],
        }

        const tools = convertToolSpecs([spec])

        // Permissions should be ignored (not part of AI SDK Tool)
        expect(tools.delete_file).toBeDefined()
        expect(tools.delete_file.description).toBe('Delete a file')
      })

      it('should not include execute function in converted tool', () => {
        const spec: ToolSpec = {
          name: 'test_tool',
          description: 'Test tool',
          parameters: { type: 'object', properties: {} },
        }

        const tools = convertToolSpecs([spec])

        // Tool should not have execute function
        expect(tools.test_tool.execute).toBeUndefined()
      })
    })

    describe('multiple tool conversion', () => {
      it('should convert multiple ToolSpecs to AI SDK tools', () => {
        const specs: ToolSpec[] = [
          {
            name: 'read_file',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
          {
            name: 'write_file',
            description: 'Write a file',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
          {
            name: 'list_directory',
            description: 'List directory contents',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ]

        const tools = convertToolSpecs(specs)

        expect(Object.keys(tools)).toHaveLength(3)
        expect(tools).toHaveProperty('read_file')
        expect(tools).toHaveProperty('write_file')
        expect(tools).toHaveProperty('list_directory')

        expect(tools.read_file.description).toBe('Read a file')
        expect(tools.write_file.description).toBe('Write a file')
        expect(tools.list_directory.description).toBe('List directory contents')
      })

      it('should preserve all parameter schemas in multi-tool conversion', () => {
        const specs: ToolSpec[] = [
          {
            name: 'tool1',
            description: 'Tool 1',
            parameters: {
              type: 'object',
              properties: { arg1: { type: 'string' } },
            },
          },
          {
            name: 'tool2',
            description: 'Tool 2',
            parameters: {
              type: 'object',
              properties: {
                arg1: { type: 'number' },
                arg2: { type: 'boolean' },
              },
            },
          },
        ]

        const tools = convertToolSpecs(specs)

        // Verify each tool has its own distinct schema
        const schema1 = tools.tool1.parameters.jsonSchema
        const schema2 = tools.tool2.parameters.jsonSchema

        expect(Object.keys(schema1.properties || {})).toEqual(['arg1'])
        expect(Object.keys(schema2.properties || {})).toEqual(['arg1', 'arg2'])
        expect((schema1.properties?.arg1 as { type: string }).type).toBe('string')
        expect((schema2.properties?.arg1 as { type: string }).type).toBe('number')
      })
    })

    describe('duplicate tool name rejection', () => {
      it('should throw ToolSchemaError for duplicate tool names', () => {
        const specs: ToolSpec[] = [
          {
            name: 'duplicate',
            description: 'First tool',
            parameters: { type: 'object', properties: {} },
          },
          {
            name: 'duplicate',
            description: 'Second tool with same name',
            parameters: { type: 'object', properties: {} },
          },
        ]

        expect(() => convertToolSpecs(specs)).toThrow(ToolSchemaError)
      })

      it('should include duplicate name in error message', () => {
        const specs: ToolSpec[] = [
          {
            name: 'my_tool',
            description: 'Tool 1',
            parameters: { type: 'object', properties: {} },
          },
          {
            name: 'my_tool',
            description: 'Tool 2',
            parameters: { type: 'object', properties: {} },
          },
        ]

        try {
          convertToolSpecs(specs)
          expect.fail('Should have thrown ToolSchemaError')
        } catch (error) {
          expect(error).toBeInstanceOf(ToolSchemaError)
          expect((error as ToolSchemaError).message).toContain('my_tool')
          expect((error as ToolSchemaError).message).toContain('Duplicate tool name')
        }
      })

      it('should set error cause to duplicate_name', () => {
        const specs: ToolSpec[] = [
          {
            name: 'tool_a',
            description: 'Tool A',
            parameters: { type: 'object', properties: {} },
          },
          {
            name: 'tool_a',
            description: 'Tool A duplicate',
            parameters: { type: 'object', properties: {} },
          },
        ]

        try {
          convertToolSpecs(specs)
          expect.fail('Should have thrown ToolSchemaError')
        } catch (error) {
          expect(error).toBeInstanceOf(ToolSchemaError)
          expect((error as ToolSchemaError).cause).toBe('duplicate_name')
        }
      })

      it('should detect duplicate even with different descriptions/schemas', () => {
        const specs: ToolSpec[] = [
          {
            name: 'same_name',
            description: 'Description 1',
            parameters: {
              type: 'object',
              properties: { arg1: { type: 'string' } },
            },
          },
          {
            name: 'same_name',
            description: 'Description 2',
            parameters: {
              type: 'object',
              properties: { arg2: { type: 'number' } },
            },
          },
        ]

        expect(() => convertToolSpecs(specs)).toThrow(ToolSchemaError)
      })
    })

    describe('edge cases', () => {
      it('should handle empty ToolSpec array', () => {
        const tools = convertToolSpecs([])

        expect(tools).toEqual({})
        expect(Object.keys(tools)).toHaveLength(0)
      })

      it('should handle complex nested parameter schemas', () => {
        const spec: ToolSpec = {
          name: 'complex_tool',
          description: 'Tool with complex parameters',
          parameters: {
            type: 'object',
            properties: {
              config: {
                type: 'object',
                properties: {
                  nested: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        key: { type: 'string' },
                        value: { type: 'number' },
                      },
                    },
                  },
                },
              },
              options: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['config'],
          },
        }

        const tools = convertToolSpecs([spec])
        const schema = tools.complex_tool.parameters.jsonSchema

        expect(schema.type).toBe('object')
        expect(schema.properties).toHaveProperty('config')
        expect(schema.properties).toHaveProperty('options')

        const configSchema = schema.properties?.config as {
          type: string
          properties: { nested: { type: string; items: object } }
        }
        expect(configSchema.type).toBe('object')
        expect(configSchema.properties.nested.type).toBe('array')
      })

      it('should handle parameter schema with enum', () => {
        const spec: ToolSpec = {
          name: 'enum_tool',
          description: 'Tool with enum parameter',
          parameters: {
            type: 'object',
            properties: {
              mode: {
                type: 'string',
                enum: ['read', 'write', 'append'],
                description: 'File operation mode',
              },
            },
            required: ['mode'],
          },
        }

        const tools = convertToolSpecs([spec])
        const schema = tools.enum_tool.parameters.jsonSchema
        const modeSchema = schema.properties?.mode as {
          type: string
          enum: string[]
        }

        expect(modeSchema.enum).toEqual(['read', 'write', 'append'])
      })

      it('should handle parameter schema with $ref', () => {
        const spec: ToolSpec = {
          name: 'ref_tool',
          description: 'Tool with $ref parameter',
          parameters: {
            type: 'object',
            properties: {
              data: { type: 'object' },
            },
            definitions: {
              CustomType: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                },
              },
            },
          },
        }

        const tools = convertToolSpecs([spec])
        const schema = tools.ref_tool.parameters.jsonSchema

        expect(schema.definitions).toHaveProperty('CustomType')
        expect((schema.definitions?.CustomType as { type: string }).type).toBe('object')
      })
    })
  })

  describe('ToolSchemaError', () => {
    it('should create error with message only', () => {
      const error = new ToolSchemaError('Test error')

      expect(error.message).toBe('Test error')
      expect(error.name).toBe('ToolSchemaError')
      expect(error.cause).toBeUndefined()
    })

    it('should create error with message and cause', () => {
      const error = new ToolSchemaError('Test error', 'duplicate_name')

      expect(error.message).toBe('Test error')
      expect(error.name).toBe('ToolSchemaError')
      expect(error.cause).toBe('duplicate_name')
    })

    it('should be instanceof Error', () => {
      const error = new ToolSchemaError('Test error')

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(ToolSchemaError)
    })
  })
})
