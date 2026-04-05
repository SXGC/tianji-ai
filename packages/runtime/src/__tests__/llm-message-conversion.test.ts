import type { AppMessage } from '@tianji/shared'
import type { CoreMessage } from 'ai'
import { describe, expect, it } from 'vitest'

import {
  ConversionError,
  appMessageToSdkMessage,
  appMessagesToSdkMessages,
  sdkMessageToAppMessage,
} from '../llm/message-conversion.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAppMessage(
  role: AppMessage['role'],
  content: AppMessage['content'],
  id = 'msg-1',
  createdAt = 1000
): AppMessage {
  return { id, role, content, createdAt }
}

// ---------------------------------------------------------------------------
// appMessageToSdkMessage
// ---------------------------------------------------------------------------

describe('appMessageToSdkMessage', () => {
  it('converts system message with a single text part', () => {
    const msg = makeAppMessage('system', [{ type: 'text', text: 'You are helpful.' }])
    const result = appMessageToSdkMessage(msg)

    expect(result.role).toBe('system')
    expect(result.content).toBe('You are helpful.')
  })

  it('throws for system message with non-text parts', () => {
    const msg = makeAppMessage('system', [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])

    expect(() => appMessageToSdkMessage(msg)).toThrow(ConversionError)
  })

  it('throws for system message with image part', () => {
    const msg = makeAppMessage('system', [{ type: 'image', url: 'https://x.com/img.png' }])

    expect(() => appMessageToSdkMessage(msg)).toThrow(ConversionError)
  })

  it('converts user text message', () => {
    const msg = makeAppMessage('user', [{ type: 'text', text: 'Hello' }])
    const result = appMessageToSdkMessage(msg)

    expect(result.role).toBe('user')
    expect(result.content).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('converts user image message', () => {
    const msg = makeAppMessage('user', [
      { type: 'image', url: 'https://x.com/img.png', mimeType: 'image/png' },
    ])
    const result = appMessageToSdkMessage(msg)

    expect(result.role).toBe('user')
    expect(result.content).toEqual([
      { type: 'image', image: 'https://x.com/img.png', mimeType: 'image/png' },
    ])
  })

  it('throws for user message with thinking part', () => {
    const msg = makeAppMessage('user', [{ type: 'thinking', thinking: 'hmm' }])

    expect(() => appMessageToSdkMessage(msg)).toThrow(ConversionError)
  })

  it('converts assistant text message', () => {
    const msg = makeAppMessage('assistant', [{ type: 'text', text: 'Hi there' }])
    const result = appMessageToSdkMessage(msg)

    expect(result.role).toBe('assistant')
    expect(result.content).toEqual([{ type: 'text', text: 'Hi there' }])
  })

  it('converts assistant thinking to reasoning', () => {
    const msg = makeAppMessage('assistant', [{ type: 'thinking', thinking: 'Let me think...' }])
    const result = appMessageToSdkMessage(msg)

    expect(result.role).toBe('assistant')
    expect(result.content).toEqual([{ type: 'reasoning', text: 'Let me think...' }])
  })

  it('converts assistant tool-call', () => {
    const msg = makeAppMessage('assistant', [
      {
        type: 'tool-call',
        toolCallId: 'tc-1',
        toolName: 'read_file',
        args: { path: '/a.txt' },
      },
    ])
    const result = appMessageToSdkMessage(msg)

    expect(result.role).toBe('assistant')
    expect(result.content).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'tc-1',
        toolName: 'read_file',
        args: { path: '/a.txt' },
      },
    ])
  })

  it('throws for assistant message with image part', () => {
    const msg = makeAppMessage('assistant', [{ type: 'image', url: 'https://x.com/img.png' }])

    expect(() => appMessageToSdkMessage(msg)).toThrow(ConversionError)
  })

  it('throws for invalid role', () => {
    const msg = makeAppMessage('tool' as AppMessage['role'], [{ type: 'text', text: 'x' }])

    expect(() => appMessageToSdkMessage(msg)).toThrow(ConversionError)
  })
})

// ---------------------------------------------------------------------------
// appMessagesToSdkMessages
// ---------------------------------------------------------------------------

describe('appMessagesToSdkMessages', () => {
  it('converts multiple messages', () => {
    const messages: AppMessage[] = [
      makeAppMessage('system', [{ type: 'text', text: 'sys prompt' }]),
      makeAppMessage('user', [{ type: 'text', text: 'hello' }]),
      makeAppMessage('assistant', [{ type: 'text', text: 'hi' }]),
    ]

    const result = appMessagesToSdkMessages(messages)

    expect(result).toHaveLength(3)
    expect(result[0].role).toBe('system')
    expect(result[1].role).toBe('user')
    expect(result[2].role).toBe('assistant')
  })

  it('returns empty array for empty input', () => {
    expect(appMessagesToSdkMessages([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// sdkMessageToAppMessage
// ---------------------------------------------------------------------------

describe('sdkMessageToAppMessage', () => {
  const id = 'test-id'
  const createdAt = 12345

  it('converts system string content', () => {
    const sdk: CoreMessage = { role: 'system', content: 'Be helpful' }
    const result = sdkMessageToAppMessage(sdk, id, createdAt)

    expect(result.id).toBe(id)
    expect(result.role).toBe('system')
    expect(result.createdAt).toBe(createdAt)
    expect(result.content).toEqual([{ type: 'text', text: 'Be helpful' }])
  })

  it('converts user string content', () => {
    const sdk: CoreMessage = { role: 'user', content: 'Hello' }
    const result = sdkMessageToAppMessage(sdk, id, createdAt)

    expect(result.role).toBe('user')
    expect(result.content).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('converts user array content with text and image', () => {
    const sdk: CoreMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this' },
        { type: 'image', image: 'https://example.com/img.png', mimeType: 'image/png' },
      ],
    }
    const result = sdkMessageToAppMessage(sdk, id, createdAt)

    expect(result.role).toBe('user')
    expect(result.content).toEqual([
      { type: 'text', text: 'Look at this' },
      { type: 'image', url: 'https://example.com/img.png', mimeType: 'image/png' },
    ])
  })

  it('converts user image with URL object', () => {
    const sdk: CoreMessage = {
      role: 'user',
      content: [
        { type: 'image', image: new URL('https://example.com/img.png'), mimeType: 'image/png' },
      ],
    }
    const result = sdkMessageToAppMessage(sdk, id, createdAt)

    expect(result.content[0]).toEqual({
      type: 'image',
      url: 'https://example.com/img.png',
      mimeType: 'image/png',
    })
  })

  it('throws for user binary image', () => {
    const sdk = {
      role: 'user' as const,
      content: [{ type: 'image', image: new Uint8Array([1, 2, 3]) }],
    } as CoreMessage

    expect(() => sdkMessageToAppMessage(sdk, id, createdAt)).toThrow(ConversionError)
  })

  it('converts assistant string content', () => {
    const sdk: CoreMessage = { role: 'assistant', content: 'Response text' }
    const result = sdkMessageToAppMessage(sdk, id, createdAt)

    expect(result.role).toBe('assistant')
    expect(result.content).toEqual([{ type: 'text', text: 'Response text' }])
  })

  it('converts assistant array with text, reasoning, and tool-call', () => {
    const sdk: CoreMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'reasoning', text: 'thinking...' },
        { type: 'tool-call', toolCallId: 'tc-1', toolName: 'search', args: { q: 'test' } },
      ],
    }
    const result = sdkMessageToAppMessage(sdk, id, createdAt)

    expect(result.content).toEqual([
      { type: 'text', text: 'answer' },
      { type: 'thinking', thinking: 'thinking...' },
      { type: 'tool-call', toolCallId: 'tc-1', toolName: 'search', args: { q: 'test' } },
    ])
  })

  it('throws for assistant reasoning with signature', () => {
    const sdk = {
      role: 'assistant' as const,
      content: [{ type: 'reasoning', text: 'thinking', signature: 'sig-123' }],
    } as CoreMessage

    expect(() => sdkMessageToAppMessage(sdk, id, createdAt)).toThrow(ConversionError)
  })

  it('throws for tool message', () => {
    const sdk: CoreMessage = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'tc-1', toolName: 'x', result: 'ok' }],
    }

    expect(() => sdkMessageToAppMessage(sdk, id, createdAt)).toThrow(ConversionError)
    try {
      sdkMessageToAppMessage(sdk, id, createdAt)
    } catch (error) {
      expect((error as ConversionError).cause).toBe('tool_message')
    }
  })

  it('throws for invalid role', () => {
    const sdk = { role: 'observer', content: 'x' } as unknown as CoreMessage

    expect(() => sdkMessageToAppMessage(sdk, id, createdAt)).toThrow(ConversionError)
    try {
      sdkMessageToAppMessage(sdk, id, createdAt)
    } catch (error) {
      expect((error as ConversionError).cause).toBe('unsupported_role')
    }
  })

  it('throws for file parts in user message', () => {
    const sdk = {
      role: 'user' as const,
      content: [{ type: 'file', data: 'abc', mimeType: 'text/plain' }],
    } as CoreMessage

    expect(() => sdkMessageToAppMessage(sdk, id, createdAt)).toThrow(ConversionError)
  })

  it('throws for redacted reasoning in assistant message', () => {
    const sdk = {
      role: 'assistant' as const,
      content: [{ type: 'redacted-reasoning', data: 'redacted' }],
    } as CoreMessage

    expect(() => sdkMessageToAppMessage(sdk, id, createdAt)).toThrow(ConversionError)
  })

  it('throws for tool-result parts in assistant message', () => {
    const sdk = {
      role: 'assistant' as const,
      content: [{ type: 'tool-result', toolCallId: 'tc-1', toolName: 'x', result: 'ok' }],
    } as CoreMessage

    expect(() => sdkMessageToAppMessage(sdk, id, createdAt)).toThrow(ConversionError)
  })
})
