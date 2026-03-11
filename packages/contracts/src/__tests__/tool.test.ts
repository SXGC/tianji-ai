import { describe, expect, it } from 'vitest'
import { ToolError } from '../errors.js'
import {
	type JSONSchema,
	type ToolInvocation,
	type ToolResult,
	type ToolSpec,
} from '../tool.js'

describe('tool types', () => {
	describe('JSONSchema', () => {
		it('should define minimal schema with required type', () => {
			const schema: JSONSchema = {
				type: 'string',
			}

			expect(schema.type).toBe('string')
		})

		it('should support object type with properties', () => {
			const schema: JSONSchema = {
				type: 'object',
				properties: {
					name: { type: 'string' },
					count: { type: 'number' },
				},
				required: ['name'],
			}

			expect(schema.type).toBe('object')
			expect(schema.properties).toBeDefined()
			expect(schema.required).toContain('name')
		})

		it('should support array type with items', () => {
			const schema: JSONSchema = {
				type: 'array',
				items: { type: 'string' },
			}

			expect(schema.type).toBe('array')
			expect(schema.items).toBeDefined()
		})

		it('should support enum type', () => {
			const schema: JSONSchema = {
				type: 'string',
				enum: ['red', 'green', 'blue'],
			}

			expect(schema.enum).toEqual(['red', 'green', 'blue'])
		})

		it('should support $schema and $ref', () => {
			const schema: JSONSchema = {
				$schema: 'http://json-schema.org/draft-07/schema#',
				$ref: '#/definitions/MyType',
				type: 'object',
			}

			expect(schema.$schema).toBeDefined()
			expect(schema.$ref).toBeDefined()
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
			expect(spec.description).toBe('Read contents of a file')
			expect(spec.parameters.type).toBe('object')
		})

		it('should include optional permissions field', () => {
			const spec: ToolSpec = {
				name: 'execute_command',
				description: 'Execute a shell command',
				parameters: { type: 'object' },
				permissions: ['shell:execute'],
			}

			expect(spec.permissions).toBeDefined()
			expect(spec.permissions).toContain('shell:execute')
		})

		it('should work without optional permissions', () => {
			const spec: ToolSpec = {
				name: 'get_weather',
				description: 'Get current weather',
				parameters: { type: 'object' },
			}

			expect(spec.permissions).toBeUndefined()
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

		it('should accept various args types', () => {
			const withObjectArgs: ToolInvocation = {
				toolCallId: 'call_1',
				toolName: 'tool',
				args: { nested: { value: 42 } },
			}

			const withArrayArgs: ToolInvocation = {
				toolCallId: 'call_2',
				toolName: 'tool',
				args: [1, 2, 3],
			}

			const withStringArgs: ToolInvocation = {
				toolCallId: 'call_3',
				toolName: 'tool',
				args: 'simple string',
			}

			expect(withObjectArgs.args).toEqual({ nested: { value: 42 } })
			expect(withArrayArgs.args).toEqual([1, 2, 3])
			expect(withStringArgs.args).toBe('simple string')
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

			expect(result.toolCallId).toBe('call_abc123')
			expect(result.result).toBeUndefined()
			expect(result.error).toBeInstanceOf(ToolError)
			expect(result.error?.code).toBe('FILE_NOT_FOUND')
		})

		it('should support result with null value', () => {
			const result: ToolResult = {
				toolCallId: 'call_xyz',
				result: null,
			}

			expect(result.result).toBeNull()
			expect(result.error).toBeUndefined()
		})

		it('should support result with complex object', () => {
			const result: ToolResult = {
				toolCallId: 'call_complex',
				result: {
					files: ['a.ts', 'b.ts'],
					count: 2,
					metadata: { encoding: 'utf-8' },
				},
			}

			expect(result.result).toEqual({
				files: ['a.ts', 'b.ts'],
				count: 2,
				metadata: { encoding: 'utf-8' },
			})
		})
	})

	describe('ToolResult with ToolError integration', () => {
		it('should use ToolError from errors module', () => {
			const toolError = new ToolError('PERMISSION_DENIED', 'Access denied')
			const result: ToolResult = {
				toolCallId: 'call_perm',
				result: undefined,
				error: toolError,
			}

			expect(result.error).toBeInstanceOf(ToolError)
			expect(result.error?.category).toBe('tool')
			expect(result.error?.message).toBe('Access denied')
		})

		it('should serialize ToolError in result', () => {
			const toolError = new ToolError('EXEC_FAILED', 'Execution failed', {
				cause: new Error('Inner error'),
			})
			const result: ToolResult = {
				toolCallId: 'call_serial',
				result: undefined,
				error: toolError,
			}

			const plainError = result.error?.toPlainObject()
			expect(plainError).toBeDefined()
			expect(plainError?.code).toBe('EXEC_FAILED')
			expect(plainError?.category).toBe('tool')

			// Should be JSON serializable
			const json = JSON.stringify({ result })
			expect(() => JSON.parse(json)).not.toThrow()
		})
	})

	describe('Tool types integration', () => {
		it('should create complete tool workflow', () => {
			// Define tool spec
			const spec: ToolSpec = {
				name: 'search_files',
				description: 'Search for files matching a pattern',
				parameters: {
					type: 'object',
					properties: {
						pattern: { type: 'string', description: 'Search pattern' },
						maxResults: { type: 'number', description: 'Max results' },
					},
					required: ['pattern'],
				},
				permissions: ['fs:read'],
			}

			// AI invokes tool
			const invocation: ToolInvocation = {
				toolCallId: 'call_search_001',
				toolName: spec.name,
				args: { pattern: '*.ts', maxResults: 10 },
			}

			// Tool returns result
			const result: ToolResult = {
				toolCallId: invocation.toolCallId,
				result: ['src/index.ts', 'src/utils.ts'],
			}

			expect(spec.name).toBe(invocation.toolName)
			expect(invocation.toolCallId).toBe(result.toolCallId)
			expect(result.result).toEqual(['src/index.ts', 'src/utils.ts'])
		})

		it('should handle tool workflow with error', () => {
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
				permissions: ['fs:write', 'fs:delete'],
			}

			const invocation: ToolInvocation = {
				toolCallId: 'call_delete_001',
				toolName: spec.name,
				args: { path: '/protected/file.txt' },
			}

			const error = new ToolError(
				'PERMISSION_DENIED',
				'Cannot delete protected file',
			)
			const result: ToolResult = {
				toolCallId: invocation.toolCallId,
				result: undefined,
				error,
			}

			expect(result.error).toBeInstanceOf(ToolError)
			expect(result.error?.code).toBe('PERMISSION_DENIED')
		})
	})
})
