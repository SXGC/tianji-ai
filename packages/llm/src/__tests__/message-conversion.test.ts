import { describe, it, expect } from 'vitest'
import type { AppMessage } from '@tianji/contracts'
import type { CoreMessage } from 'ai'
import {
	appMessagesToSdkMessages,
	sdkMessageToAppMessage,
	ConversionError,
} from '../message-conversion'

describe('message conversion', () => {
	describe('appMessagesToSdkMessages', () => {
		it('should convert user message with text content', () => {
			const appMessage: AppMessage = {
				id: 'msg-001',
				role: 'user',
				content: [{ type: 'text', text: 'Hello world' }],
				createdAt: Date.now(),
			}

			const result = appMessagesToSdkMessages([appMessage])

			expect(result).toHaveLength(1)
			const [msg] = result
			expect(msg.role).toBe('user')
			expect(msg.content).toEqual([{ type: 'text', text: 'Hello world' }])
		})

		it('should convert user message with image content', () => {
			const appMessage: AppMessage = {
				id: 'msg-002',
				role: 'user',
				content: [
					{ type: 'text', text: 'What is this?' },
					{ type: 'image', url: 'https://example.com/image.png', mimeType: 'image/png' },
				],
				createdAt: Date.now(),
			}

			const result = appMessagesToSdkMessages([appMessage])

			expect(result).toHaveLength(1)
			const [msg] = result
			expect(msg.role).toBe('user')
			if (Array.isArray(msg.content)) {
				const content = msg.content as Array<{ type: string; image?: string; mimeType?: string }>
				expect(content[0]).toEqual({ type: 'text', text: 'What is this?' })
				expect(content[1]).toEqual({ type: 'image', image: 'https://example.com/image.png', mimeType: 'image/png' })
			}
		})

		it('should convert assistant message with thinking and text content', () => {
			const appMessage: AppMessage = {
				id: 'msg-003',
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'Let me analyze...' },
					{ type: 'text', text: 'Here is the analysis.' },
					{ type: 'tool-call', toolCallId: 'call-001', toolName: 'search', args: { query: 'test' } },
				],
				createdAt: Date.now(),
			}

			const result = appMessagesToSdkMessages([appMessage])

			expect(result).toHaveLength(1)
			const [msg] = result
			expect(msg.role).toBe('assistant')
			if (Array.isArray(msg.content)) {
				const content = msg.content as Array<{ type: string; text?: string; thinking?: string; toolCallId?: string; toolName?: string; args?: unknown }>
				// Should have reasoning, text, and tool-call parts
				expect(content.find(c => c.type === 'reasoning')).toBeDefined()
				expect(content.find(c => c.type === 'text')).toBeDefined()
				expect(content.find(c => c.type === 'tool-call')).toBeDefined()
			}
		})

		it('should convert system message', () => {
			const appMessage: AppMessage = {
				id: 'msg-004',
				role: 'system',
				content: [{ type: 'text', text: 'You are a helpful assistant.' }],
				createdAt: Date.now(),
			}

			const result = appMessagesToSdkMessages([appMessage])

			expect(result).toHaveLength(1)
			const [msg] = result
			expect(msg.role).toBe('system')
			expect(msg.content).toBe('You are a helpful assistant.')
		})

		it('should throw for system message with multiple parts', () => {
			const appMessage = {
				id: 'msg-sys-multi',
				role: 'system' as const,
				content: [
					{ type: 'text', text: 'Part 1' },
					{ type: 'text', text: 'Part 2' },
				],
				createdAt: Date.now(),
			} as AppMessage

			expect(() => appMessagesToSdkMessages([appMessage])).toThrow(ConversionError)
		})

		it('should throw for user message with thinking content', () => {
			const appMessage = {
				id: 'msg-user-think',
				role: 'user' as const,
				content: [{ type: 'thinking', thinking: 'Hmm...' }],
				createdAt: Date.now(),
			} as unknown as AppMessage

			expect(() => appMessagesToSdkMessages([appMessage])).toThrow(ConversionError)
		})

		it('should throw for user message with tool-call content', () => {
			const appMessage = {
				id: 'msg-user-tool',
				role: 'user' as const,
				content: [{ type: 'tool-call', toolCallId: 'tc-001', toolName: 'test', args: {} }],
				createdAt: Date.now(),
			} as unknown as AppMessage

			expect(() => appMessagesToSdkMessages([appMessage])).toThrow(ConversionError)
		})

		it('should throw for assistant message with image content', () => {
			const appMessage = {
				id: 'msg-assistant-img',
				role: 'assistant' as const,
				content: [{ type: 'image', url: 'https://example.com/img.png' }],
				createdAt: Date.now(),
			} as unknown as AppMessage

			expect(() => appMessagesToSdkMessages([appMessage])).toThrow(ConversionError)
		})

		it('should throw for unsupported role', () => {
			const appMessage = {
				id: 'msg-005',
				role: 'tool' as unknown as 'user',
				content: [],
				createdAt: Date.now(),
			} as AppMessage
			expect(() => appMessagesToSdkMessages([appMessage])).toThrow(ConversionError)
		})
	})

	describe('sdkMessageToAppMessage', () => {
		it('should convert user CoreMessage to AppMessage', () => {
			const coreMessage = {
				role: 'user',
				content: [
					{ type: 'text', text: 'Hello' },
					{ type: 'image', image: new URL('https://example.com/photo.jpg'), mimeType: 'image/jpeg' },
				],
			} satisfies CoreMessage

			const result = sdkMessageToAppMessage(coreMessage, 'msg-converted', Date.now())

			expect(result.role).toBe('user')
			expect(result.content).toHaveLength(2)
			expect(result.content[0]).toEqual({ type: 'text', text: 'Hello' })
			expect(result.content[1]).toEqual({
				type: 'image',
				url: 'https://example.com/photo.jpg',
				mimeType: 'image/jpeg',
			})
		})

		it('should convert assistant CoreMessage with reasoning and tool calls', () => {
			const coreMessage = {
				role: 'assistant',
				content: [
					{ type: 'reasoning', text: 'Thinking about the problem...' },
					{ type: 'text', text: 'The answer is 42.' },
					{ type: 'tool-call', toolCallId: 'tc-001', toolName: 'calculate', args: { a: 1, b: 2 } },
				],
			} satisfies CoreMessage

			const result = sdkMessageToAppMessage(coreMessage, 'msg-converted', Date.now())

			expect(result.role).toBe('assistant')
			expect(result.content).toHaveLength(3)
			expect(result.content[0]).toEqual({ type: 'thinking', thinking: 'Thinking about the problem...' })
			expect(result.content[1]).toEqual({ type: 'text', text: 'The answer is 42.' })
			expect(result.content[2]).toEqual({
				type: 'tool-call',
				toolCallId: 'tc-001',
				toolName: 'calculate',
				args: { a: 1, b: 2 },
			})
		})

		it('should convert system CoreMessage to AppMessage', () => {
			const coreMessage = {
				role: 'system',
				content: 'You are a helpful assistant.',
			} satisfies CoreMessage

			const result = sdkMessageToAppMessage(coreMessage, 'msg-converted', Date.now())

			expect(result.role).toBe('system')
			expect(result.content).toHaveLength(1)
			expect(result.content[0]).toEqual({ type: 'text', text: 'You are a helpful assistant.' })
		})

		it('should throw for tool CoreMessage (not supported)', () => {
			const coreMessage = {
				role: 'tool',
				content: [{ type: 'tool-result', toolCallId: 'tc-001', toolName: 'test', result: 'done' }],
			} satisfies CoreMessage

			expect(() => sdkMessageToAppMessage(coreMessage, 'msg-converted', Date.now())).toThrow(ConversionError)
		})

		it('should throw for user CoreMessage with file part', () => {
			const coreMessage = {
				role: 'user',
				content: [{ type: 'file', data: 'base64data', mimeType: 'application/pdf' }],
			} satisfies CoreMessage

			expect(() => sdkMessageToAppMessage(coreMessage, 'msg-converted', Date.now())).toThrow(ConversionError)
		})

		it('should throw for assistant CoreMessage with reasoning that has signature', () => {
			const coreMessage = {
				role: 'assistant',
				content: [{ type: 'reasoning', text: 'Thinking...', signature: 'abc123' }],
			} satisfies CoreMessage

			expect(() => sdkMessageToAppMessage(coreMessage, 'msg-converted', Date.now())).toThrow(ConversionError)
		})

		it('should throw for assistant CoreMessage with redacted-reasoning part', () => {
			const coreMessage = {
				role: 'assistant',
				content: [{ type: 'redacted-reasoning', data: 'redacted' }],
			} satisfies CoreMessage

			expect(() => sdkMessageToAppMessage(coreMessage, 'msg-converted', Date.now())).toThrow(ConversionError)
		})

		it('should throw for user CoreMessage with tool-call part', () => {
			// Invalid fixture: user role with tool-call content (not valid per AI SDK types)
			const coreMessage = {
				role: 'user',
				content: [{ type: 'tool-call', toolCallId: 'tc-001', toolName: 'test', args: {} }],
			} as unknown as CoreMessage

			expect(() => sdkMessageToAppMessage(coreMessage, 'msg-converted', Date.now())).toThrow(ConversionError)
		})

		it('should throw for user CoreMessage with reasoning part', () => {
			// Invalid fixture: user role with reasoning content (not valid per AI SDK types)
			const coreMessage = {
				role: 'user',
				content: [{ type: 'reasoning', text: 'Thinking...' }],
			} as unknown as CoreMessage

			expect(() => sdkMessageToAppMessage(coreMessage, 'msg-converted', Date.now())).toThrow(ConversionError)
		})

		it('should throw for assistant CoreMessage with image part', () => {
			// Invalid fixture: assistant role with image content (not valid per AI SDK types)
			const coreMessage = {
				role: 'assistant',
				content: [{ type: 'image', image: 'https://example.com/img.png' }],
			} as unknown as CoreMessage

		expect(() => sdkMessageToAppMessage(coreMessage, 'msg-converted', Date.now())).toThrow(ConversionError)
		})
	})

	describe('round-trip conversion', () => {
		it('should maintain text content through round-trip', () => {
			const original: AppMessage = {
				id: 'msg-001',
				role: 'user',
				content: [{ type: 'text', text: 'Hello world' }],
				createdAt: Date.now(),
			}

			const sdk = appMessagesToSdkMessages([original])
			const back = sdkMessageToAppMessage(sdk[0], 'msg-001', Date.now())

			expect(back.role).toBe('user')
			expect(back.content).toEqual([{ type: 'text', text: 'Hello world' }])
		})

		it('should maintain image content through round-trip', () => {
			const original: AppMessage = {
				id: 'msg-002',
				role: 'user',
				content: [
					{ type: 'text', text: 'Check this image:' },
					{ type: 'image', url: 'https://example.com/photo.jpg', mimeType: 'image/jpeg' },
				],
				createdAt: Date.now(),
			}

			const sdk = appMessagesToSdkMessages([original])
			const back = sdkMessageToAppMessage(sdk[0], 'msg-002', Date.now())

			expect(back.role).toBe('user')
			expect(back.content).toHaveLength(2)
			expect(back.content[0]).toEqual({ type: 'text', text: 'Check this image:' })
			expect(back.content[1]).toEqual({
				type: 'image',
				url: 'https://example.com/photo.jpg',
				mimeType: 'image/jpeg',
			})
		})

		it('should maintain tool-call through round-trip', () => {
			const original: AppMessage = {
				id: 'msg-003',
				role: 'assistant',
				content: [
					{ type: 'tool-call', toolCallId: 'tc-001', toolName: 'search', args: { query: 'test' } },
				],
				createdAt: Date.now(),
			}

			const sdk = appMessagesToSdkMessages([original])
			const back = sdkMessageToAppMessage(sdk[0], 'msg-003', Date.now())

			expect(back.role).toBe('assistant')
			expect(back.content).toHaveLength(1)
			expect(back.content[0]).toEqual({
				type: 'tool-call',
				toolCallId: 'tc-001',
				toolName: 'search',
				args: { query: 'test' },
			})
		})

		it('should maintain thinking content through round-trip', () => {
			const original: AppMessage = {
				id: 'msg-004',
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'Deep analysis here...' },
					{ type: 'text', text: 'Based on my analysis...' },
				],
				createdAt: Date.now(),
			}

			const sdk = appMessagesToSdkMessages([original])
			const back = sdkMessageToAppMessage(sdk[0], 'msg-004', Date.now())

			expect(back.role).toBe('assistant')
			expect(back.content).toHaveLength(2)
			expect(back.content[0]).toEqual({ type: 'thinking', thinking: 'Deep analysis here...' })
			expect(back.content[1]).toEqual({ type: 'text', text: 'Based on my analysis...' })
		})

		it('should preserve content order through round-trip', () => {
			const original: AppMessage = {
				id: 'msg-005',
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'First thought' },
					{ type: 'tool-call', toolCallId: 'tc-001', toolName: 'search', args: { q: 'a' } },
					{ type: 'text', text: 'Result text' },
					{ type: 'thinking', thinking: 'Second thought' },
				],
				createdAt: Date.now(),
			}

			const sdk = appMessagesToSdkMessages([original])
			const back = sdkMessageToAppMessage(sdk[0], 'msg-005', Date.now())

			expect(back.role).toBe('assistant')
			expect(back.content).toHaveLength(4)
			expect(back.content[0]).toEqual({ type: 'thinking', thinking: 'First thought' })
			expect(back.content[1]).toEqual({
				type: 'tool-call',
				toolCallId: 'tc-001',
				toolName: 'search',
				args: { q: 'a' },
			})
			expect(back.content[2]).toEqual({ type: 'text', text: 'Result text' })
			expect(back.content[3]).toEqual({ type: 'thinking', thinking: 'Second thought' })
		})
	})

	describe('ConversionError', () => {
		it('should have correct name property', () => {
			const error = new ConversionError('test error')
			expect(error.name).toBe('ConversionError')
		})

		it('should include cause property', () => {
			const error = new ConversionError('test error', 'unsupported_role')
			expect(error.cause).toBe('unsupported_role')
		})

		it('should be instance of Error', () => {
			const error = new ConversionError('test error')
			expect(error).toBeInstanceOf(Error)
		})
	})
})
