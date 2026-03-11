import { describe, expect, it } from 'vitest'
import type { Artifact, ArtifactType } from '../artifact.js'

describe('artifact types', () => {
	describe('ArtifactType', () => {
		it('should define code-snippet type', () => {
			const type: ArtifactType = 'code-snippet'
			expect(type).toBe('code-snippet')
		})

		it('should define file-change type', () => {
			const type: ArtifactType = 'file-change'
			expect(type).toBe('file-change')
		})

		it('should define image type', () => {
			const type: ArtifactType = 'image'
			expect(type).toBe('image')
		})

		it('should define structured-result type', () => {
			const type: ArtifactType = 'structured-result'
			expect(type).toBe('structured-result')
		})

		it('should be assignable to string', () => {
			const type: ArtifactType = 'code-snippet'
			const str: string = type
			expect(str).toBe('code-snippet')
		})

		it('should allow type narrowing with switch', () => {
			const types: ArtifactType[] = [
				'code-snippet',
				'file-change',
				'image',
				'structured-result',
			]

			for (const type of types) {
				let result: string
				switch (type) {
					case 'code-snippet':
						result = 'code'
						break
					case 'file-change':
						result = 'file'
						break
					case 'image':
						result = 'image'
						break
					case 'structured-result':
						result = 'result'
						break
				}
				expect(result).toBeDefined()
			}
		})
	})

	describe('Artifact', () => {
		it('should define required fields for code-snippet', () => {
			const artifact: Artifact = {
				id: 'artifact_001',
				type: 'code-snippet',
				name: 'hello.py',
				content: 'print("Hello")',
				createdAt: Date.now(),
			}

			expect(artifact.id).toBe('artifact_001')
			expect(artifact.type).toBe('code-snippet')
			expect(artifact.name).toBe('hello.py')
			expect(artifact.content).toBe('print("Hello")')
			expect(artifact.createdAt).toBeGreaterThan(0)
		})

		it('should include optional mimeType', () => {
			const artifact: Artifact = {
				id: 'artifact_002',
				type: 'code-snippet',
				name: 'script.py',
				content: '# Python script',
				mimeType: 'text/x-python',
				createdAt: Date.now(),
			}

			expect(artifact.mimeType).toBe('text/x-python')
		})

		it('should include optional metadata', () => {
			const artifact: Artifact = {
				id: 'artifact_003',
				type: 'code-snippet',
				name: 'app.ts',
				content: 'const x = 1',
				createdAt: Date.now(),
				metadata: {
					language: 'typescript',
					lines: 1,
					characters: 11,
				},
			}

			expect(artifact.metadata).toBeDefined()
			expect(artifact.metadata?.language).toBe('typescript')
			expect(artifact.metadata?.lines).toBe(1)
		})

		it('should work without optional fields', () => {
			const artifact: Artifact = {
				id: 'artifact_004',
				type: 'code-snippet',
				name: 'minimal.txt',
				content: 'minimal',
				createdAt: Date.now(),
			}

			expect(artifact.mimeType).toBeUndefined()
			expect(artifact.metadata).toBeUndefined()
		})
	})

	describe('Artifact with image type', () => {
		it('should support image with URL content', () => {
			const artifact: Artifact = {
				id: 'artifact_img_001',
				type: 'image',
				name: 'diagram.png',
				content: { url: 'https://example.com/diagram.png' },
				mimeType: 'image/png',
				createdAt: Date.now(),
			}

			expect(artifact.type).toBe('image')
			expect(artifact.mimeType).toBe('image/png')
			const content = artifact.content as { url: string }
			expect(content.url).toBe('https://example.com/diagram.png')
		})

		it('should support image with base64 content', () => {
			const artifact: Artifact = {
				id: 'artifact_img_002',
				type: 'image',
				name: 'photo.jpg',
				content: { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAE...' },
				mimeType: 'image/jpeg',
				createdAt: Date.now(),
			}

			const content = artifact.content as { base64: string }
			expect(content.base64).toBeDefined()
		})
	})

	describe('Artifact with file-change type', () => {
		it('should support file change with diff content', () => {
			const artifact: Artifact = {
				id: 'artifact_fc_001',
				type: 'file-change',
				name: 'src/index.ts',
				content: {
					path: '/src/index.ts',
					operation: 'create',
					diff: '--- /dev/null\n+++ b/src/index.ts\n@@ -0,0 +1 @@\n+export const x = 1',
				},
				mimeType: 'text/plain',
				createdAt: Date.now(),
			}

			expect(artifact.type).toBe('file-change')
			const content = artifact.content as {
				path: string
				operation: string
				diff: string
			}
			expect(content.path).toBe('/src/index.ts')
			expect(content.operation).toBe('create')
			expect(content.diff).toContain('+++ b/src/index.ts')
		})

		it('should support file change with modify operation', () => {
			const artifact: Artifact = {
				id: 'artifact_fc_002',
				type: 'file-change',
				name: 'config.json',
				content: {
					path: '/config.json',
					operation: 'modify',
					oldContent: '{"key": "old"}',
					newContent: '{"key": "new"}',
				},
				createdAt: Date.now(),
			}

			const content = artifact.content as {
				operation: string
				oldContent: string
				newContent: string
			}
			expect(content.operation).toBe('modify')
			expect(content.oldContent).toBe('{"key": "old"}')
			expect(content.newContent).toBe('{"key": "new"}')
		})
	})

	describe('Artifact with structured-result type', () => {
		it('should support structured JSON result', () => {
			const artifact: Artifact = {
				id: 'artifact_sr_001',
				type: 'structured-result',
				name: 'analysis-result',
				content: {
					summary: 'Analysis complete',
					findings: [
						{ id: 1, severity: 'high', message: 'Issue found' },
						{ id: 2, severity: 'low', message: 'Minor issue' },
					],
					metrics: { totalFiles: 10, issuesFound: 2 },
				},
				mimeType: 'application/json',
				createdAt: Date.now(),
			}

			expect(artifact.type).toBe('structured-result')
			const content = artifact.content as {
				summary: string
				findings: Array<{ id: number; severity: string }>
			}
			expect(content.summary).toBe('Analysis complete')
			expect(content.findings).toHaveLength(2)
		})

		it('should support structured table result', () => {
			const artifact: Artifact = {
				id: 'artifact_sr_002',
				type: 'structured-result',
				name: 'data-table',
				content: {
					columns: ['Name', 'Value', 'Status'],
					rows: [
						['Item 1', '100', 'Active'],
						['Item 2', '200', 'Inactive'],
					],
				},
				createdAt: Date.now(),
				metadata: { format: 'table' },
			}

			const content = artifact.content as {
				columns: string[]
				rows: string[][]
			}
			expect(content.columns).toEqual(['Name', 'Value', 'Status'])
			expect(content.rows).toHaveLength(2)
		})
	})



	describe('Artifact content flexibility', () => {
		it('should allow string content', () => {
			const artifact: Artifact = {
				id: 'artifact_str',
				type: 'code-snippet',
				name: 'string.txt',
				content: 'plain string content',
				createdAt: Date.now(),
			}

			expect(typeof artifact.content).toBe('string')
		})

		it('should allow object content', () => {
			const artifact: Artifact = {
				id: 'artifact_obj',
				type: 'structured-result',
				name: 'object.json',
				content: { key: 'value', nested: { inner: true } },
				createdAt: Date.now(),
			}

			expect(typeof artifact.content).toBe('object')
		})

		it('should allow array content', () => {
			const artifact: Artifact = {
				id: 'artifact_arr',
				type: 'structured-result',
				name: 'array.json',
				content: [1, 2, 3, 'four', { five: 5 }],
				createdAt: Date.now(),
			}

			expect(Array.isArray(artifact.content)).toBe(true)
		})

		it('should allow null content', () => {
			const artifact: Artifact = {
				id: 'artifact_null',
				type: 'structured-result',
				name: 'null.json',
				content: null,
				createdAt: Date.now(),
			}

			expect(artifact.content).toBeNull()
		})

		it('should allow undefined content', () => {
			const artifact: Artifact = {
				id: 'artifact_undefined',
				type: 'structured-result',
				name: 'undefined.json',
				content: undefined,
				createdAt: Date.now(),
			}

			expect(artifact.content).toBeUndefined()
		})

		it('should allow number content', () => {
			const artifact: Artifact = {
				id: 'artifact_num',
				type: 'structured-result',
				name: 'number.json',
				content: 42,
				createdAt: Date.now(),
			}

			expect(artifact.content).toBe(42)
		})

		it('should allow boolean content', () => {
			const artifact: Artifact = {
				id: 'artifact_bool',
				type: 'structured-result',
				name: 'boolean.json',
				content: true,
				createdAt: Date.now(),
			}

			expect(artifact.content).toBe(true)
		})
	})

	describe('Artifact type discrimination', () => {
		it('should narrow type based on artifact.type', () => {
			const artifacts: Artifact[] = [
				{ id: '1', type: 'code-snippet', name: 'a', content: '', createdAt: 0 },
				{ id: '2', type: 'file-change', name: 'b', content: {}, createdAt: 0 },
				{ id: '3', type: 'image', name: 'c', content: {}, createdAt: 0 },
				{ id: '4', type: 'structured-result', name: 'd', content: {}, createdAt: 0 },
			]

			const codeSnippets = artifacts.filter((a) => a.type === 'code-snippet')
			const fileChanges = artifacts.filter((a) => a.type === 'file-change')
			const images = artifacts.filter((a) => a.type === 'image')
			const structured = artifacts.filter((a) => a.type === 'structured-result')

			expect(codeSnippets).toHaveLength(1)
			expect(fileChanges).toHaveLength(1)
			expect(images).toHaveLength(1)
			expect(structured).toHaveLength(1)
		})
	})
})
