import { describe, expect, it } from 'vitest'
import type {
  AppMessage,
  ImageContent,
  MessagePart,
  MessageRole,
  TextContent,
  ThinkingContent,
  ToolCall,
} from '../message.js'

describe('message types', () => {
  describe('MessageRole', () => {
    it('should accept valid roles', () => {
      const roles: MessageRole[] = ['user', 'assistant', 'system']
      expect(roles).toHaveLength(3)
      expect(roles).toContain('user')
      expect(roles).toContain('assistant')
      expect(roles).toContain('system')
    })
  })

  describe('TextContent', () => {
    it('should define required fields', () => {
      const content: TextContent = {
        type: 'text',
        text: 'Hello, world!',
      }

      expect(content.type).toBe('text')
      expect(content.text).toBe('Hello, world!')
    })

    it('should accept empty text', () => {
      const content: TextContent = {
        type: 'text',
        text: '',
      }

      expect(content.text).toBe('')
    })

    it('should accept long text', () => {
      const longText = 'a'.repeat(10000)
      const content: TextContent = {
        type: 'text',
        text: longText,
      }

      expect(content.text).toHaveLength(10000)
    })
  })

  describe('ThinkingContent', () => {
    it('should define required fields', () => {
      const content: ThinkingContent = {
        type: 'thinking',
        thinking: 'Analyzing the problem...',
      }

      expect(content.type).toBe('thinking')
      expect(content.thinking).toBe('Analyzing the problem...')
    })

    it('should accept multi-line thinking', () => {
      const content: ThinkingContent = {
        type: 'thinking',
        thinking: 'Step 1: Analyze\nStep 2: Process\nStep 3: Output',
      }

      expect(content.thinking).toContain('\n')
    })
  })

  describe('ImageContent', () => {
    it('should define required fields', () => {
      const content: ImageContent = {
        type: 'image',
        url: 'https://example.com/image.png',
      }

      expect(content.type).toBe('image')
      expect(content.url).toBe('https://example.com/image.png')
      expect(content.mimeType).toBeUndefined()
    })

    it('should include optional mimeType', () => {
      const content: ImageContent = {
        type: 'image',
        url: 'https://example.com/photo',
        mimeType: 'image/jpeg',
      }

      expect(content.mimeType).toBe('image/jpeg')
    })

    it('should accept data URI', () => {
      const content: ImageContent = {
        type: 'image',
        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        mimeType: 'image/png',
      }

      expect(content.url).toMatch(/^data:image\/png;base64,/)
    })

    it('should accept various image mime types', () => {
      const mimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
      for (const mimeType of mimeTypes) {
        const content: ImageContent = {
          type: 'image',
          url: 'https://example.com/img',
          mimeType,
        }
        expect(content.mimeType).toBe(mimeType)
      }
    })
  })

  describe('ToolCall', () => {
    it('should define required fields', () => {
      const content: ToolCall = {
        type: 'tool-call',
        toolCallId: 'call_abc123',
        toolName: 'read_file',
        args: { path: '/src/index.ts' },
      }

      expect(content.type).toBe('tool-call')
      expect(content.toolCallId).toBe('call_abc123')
      expect(content.toolName).toBe('read_file')
      expect(content.args).toEqual({ path: '/src/index.ts' })
    })

    it('should accept various args types', () => {
      const withObjectArgs: ToolCall = {
        type: 'tool-call',
        toolCallId: 'call_1',
        toolName: 'search',
        args: { query: 'test', limit: 10 },
      }

      const withArrayArgs: ToolCall = {
        type: 'tool-call',
        toolCallId: 'call_2',
        toolName: 'batch',
        args: ['item1', 'item2', 'item3'],
      }

      const withNoArgs: ToolCall = {
        type: 'tool-call',
        toolCallId: 'call_3',
        toolName: 'ping',
        args: undefined,
      }

      expect(withObjectArgs.args).toEqual({ query: 'test', limit: 10 })
      expect(withArrayArgs.args).toEqual(['item1', 'item2', 'item3'])
      expect(withNoArgs.args).toBeUndefined()
    })
  })

  describe('MessagePart', () => {
    it('should accept TextContent', () => {
      const part: MessagePart = {
        type: 'text',
        text: 'Hello',
      }
      expect(part.type).toBe('text')
    })

    it('should accept ThinkingContent', () => {
      const part: MessagePart = {
        type: 'thinking',
        thinking: 'Processing...',
      }
      expect(part.type).toBe('thinking')
    })

    it('should accept ImageContent', () => {
      const part: MessagePart = {
        type: 'image',
        url: 'https://example.com/img.png',
      }
      expect(part.type).toBe('image')
    })

    it('should accept ToolCall', () => {
      const part: MessagePart = {
        type: 'tool-call',
        toolCallId: 'call_123',
        toolName: 'test',
        args: {},
      }
      expect(part.type).toBe('tool-call')
    })
  })

  describe('AppMessage', () => {
    it('should define required fields', () => {
      const message: AppMessage = {
        id: 'msg_001',
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        createdAt: 1234567890000,
      }

      expect(message.id).toBe('msg_001')
      expect(message.role).toBe('user')
      expect(message.content).toHaveLength(1)
      expect(message.createdAt).toBe(1234567890000)
    })

    it('should accept all role types', () => {
      const userMessage: AppMessage = {
        id: 'msg_1',
        role: 'user',
        content: [],
        createdAt: Date.now(),
      }

      const assistantMessage: AppMessage = {
        id: 'msg_2',
        role: 'assistant',
        content: [],
        createdAt: Date.now(),
      }

      const systemMessage: AppMessage = {
        id: 'msg_3',
        role: 'system',
        content: [],
        createdAt: Date.now(),
      }

      expect(userMessage.role).toBe('user')
      expect(assistantMessage.role).toBe('assistant')
      expect(systemMessage.role).toBe('system')
    })

    it('should accept multiple content parts', () => {
      const message: AppMessage = {
        id: 'msg_multi',
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this image:' },
          { type: 'image', url: 'https://example.com/img.png', mimeType: 'image/png' },
        ],
        createdAt: Date.now(),
      }

      expect(message.content).toHaveLength(2)
      expect(message.content[0].type).toBe('text')
      expect(message.content[1].type).toBe('image')
    })

    it('should accept empty content array', () => {
      const message: AppMessage = {
        id: 'msg_empty',
        role: 'assistant',
        content: [],
        createdAt: Date.now(),
      }

      expect(message.content).toEqual([])
    })

    it('should support complex message with all part types', () => {
      const message: AppMessage = {
        id: 'msg_complex',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Analyzing the request...' },
          { type: 'text', text: 'I will search for that.' },
          {
            type: 'tool-call',
            toolCallId: 'call_search_001',
            toolName: 'search',
            args: { query: 'tianji' },
          },
          { type: 'text', text: 'Here are the results.' },
        ],
        createdAt: Date.now(),
      }

      expect(message.content).toHaveLength(4)
      expect(message.content[0].type).toBe('thinking')
      expect(message.content[1].type).toBe('text')
      expect(message.content[2].type).toBe('tool-call')
      expect(message.content[3].type).toBe('text')
    })
  })
})
