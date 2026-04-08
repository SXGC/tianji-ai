/**
 * Message types for tianji-ai
 *
 * Defines the contract for messages exchanged between user, assistant, and system.
 * Messages are composed of multiple content parts (text, thinking, image, tool calls).
 *
 * @module message
 */

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface TextContent {
  readonly type: 'text'
  readonly text: string
}

export interface ThinkingContent {
  readonly type: 'thinking'
  readonly thinking: string
}

export interface ImageContent {
  readonly type: 'image'
  readonly url: string
  readonly mimeType?: string
}

export interface ToolCall {
  readonly type: 'tool-call'
  readonly toolCallId: string
  readonly toolName: string
  readonly args: unknown
}

export interface ToolResultContent {
  readonly type: 'tool-result'
  readonly toolCallId: string
  readonly toolName: string
  readonly result: unknown
  readonly isError?: boolean
}

export type MessagePart =
  | TextContent
  | ThinkingContent
  | ImageContent
  | ToolCall
  | ToolResultContent

export interface AppMessage {
  readonly id: string
  readonly role: MessageRole
  readonly content: MessagePart[]
  readonly createdAt: number
}
