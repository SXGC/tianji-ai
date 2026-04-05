import { describe, expectTypeOf, it } from 'vitest'
import type {
  AppMessage,
  ImageContent,
  MessagePart,
  MessageRole,
  TextContent,
  ThinkingContent,
  ToolCall,
} from '../message.js'

describe('message type contracts', () => {
  it('MessageRole is a string union', () => {
    expectTypeOf<MessageRole>().toEqualTypeOf<'user' | 'assistant' | 'system'>()
  })

  it('MessagePart is a union of content types', () => {
    expectTypeOf<TextContent>().toMatchTypeOf<MessagePart>()
    expectTypeOf<ThinkingContent>().toMatchTypeOf<MessagePart>()
    expectTypeOf<ImageContent>().toMatchTypeOf<MessagePart>()
    expectTypeOf<ToolCall>().toMatchTypeOf<MessagePart>()
  })

  it('AppMessage requires id, role, content, createdAt', () => {
    expectTypeOf<AppMessage>().toHaveProperty('id')
    expectTypeOf<AppMessage>().toHaveProperty('role')
    expectTypeOf<AppMessage>().toHaveProperty('content')
    expectTypeOf<AppMessage>().toHaveProperty('createdAt')
  })
})
