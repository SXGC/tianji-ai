import { describe, expect, it } from 'vitest'
import { ToolError } from '../errors.js'
import type { JSONSchema, ToolInvocation, ToolResult, ToolSpec } from '../tool.js'

describe('tool types', () => {
  describe('JSONSchema', () => {
    it('should define minimal schema with required type', () => {
      const schema: JSONSchema = {
        type: 'string',
      }

      expect(schema.type).toBe('string')
    })
  })

  describe('ToolSpec', () => {
    it('should define required fields', () => {
      const spec: ToolSpec = {
        name: 'read_file',
        description: 'Read contents of a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
        },
      }

      expect(spec.name).toBe('read_file')
      expect(spec.parameters.type).toBe('object')
    })
  })

  describe('ToolInvocation', () => {
    it('should define required fields', () => {
      const invocation: ToolInvocation = {
        toolCallId: 'call_abc123',
        toolName: 'read_file',
        args: { path: '/src/index.ts' },
      }

      expect(invocation.toolCallId).toBe('call_abc123')
      expect(invocation.toolName).toBe('read_file')
      expect(invocation.args).toEqual({ path: '/src/index.ts' })
    })
  })

  describe('ToolResult', () => {
    it('should define successful result', () => {
      const result: ToolResult = {
        toolCallId: 'call_abc123',
        result: 'file contents here',
      }

      expect(result.toolCallId).toBe('call_abc123')
      expect(result.result).toBe('file contents here')
      expect(result.error).toBeUndefined()
    })

    it('should define error result', () => {
      const error = new ToolError('FILE_NOT_FOUND', 'File does not exist')
      const result: ToolResult = {
        toolCallId: 'call_abc123',
        result: undefined,
        error,
      }

      expect(result.error).toBeInstanceOf(ToolError)
      expect(result.error?.code).toBe('FILE_NOT_FOUND')
    })
  })
})
