/**
 * Message types for tianji-ai
 *
 * Defines the contract for messages exchanged between user, assistant, and system.
 * Messages are composed of multiple content parts (text, thinking, image, tool calls).
 *
 * @module message
 */

// ============================================================================
// Message Role
// ============================================================================

/**
 * Role of a message sender in the conversation.
 *
 * - 'user': Message from the human user
 * - 'assistant': Message from the AI assistant
 * - 'system': System-level instruction or context
 */
export type MessageRole = 'user' | 'assistant' | 'system'

// ============================================================================
// Message Content Types
// ============================================================================

/**
 * Text content in a message.
 *
 * The most common content type, representing plain text.
 */
export interface TextContent {
  /** Discriminator for text content */
  readonly type: 'text'
  /** The text content */
  readonly text: string
}

/**
 * Thinking/reasoning content in a message.
 *
 * Represents the AI's internal reasoning process, typically shown
 * in specialized UI contexts (e.g., "thinking" blocks in Claude).
 */
export interface ThinkingContent {
  /** Discriminator for thinking content */
  readonly type: 'thinking'
  /** The thinking/reasoning content */
  readonly thinking: string
}

/**
 * Image content in a message.
 *
 * Represents an image, either by URL or embedded data.
 * mimeType is optional when URL includes recognizable extension.
 */
export interface ImageContent {
  /** Discriminator for image content */
  readonly type: 'image'
  /** URL or data URI of the image */
  readonly url: string
  /** Optional MIME type (e.g., 'image/png', 'image/jpeg') */
  readonly mimeType?: string
}

/**
 * Tool call content in a message.
 *
 * Represents the AI's request to invoke a tool.
 * The toolCallId is used to correlate with the corresponding ToolResult.
 */
export interface ToolCall {
  /** Discriminator for tool call content */
  readonly type: 'tool-call'
  /** Unique identifier for this tool call, used to correlate with ToolResult */
  readonly toolCallId: string
  /** Name of the tool to invoke (must match a registered ToolSpec) */
  readonly toolName: string
  /** Arguments to pass to the tool (should match tool's parameter schema) */
  readonly args: unknown
}

// ============================================================================
// Message Part Union
// ============================================================================

/**
 * Union type of all possible message content parts.
 *
 * A single message can contain multiple parts of different types,
 * enabling rich multi-modal and tool-interleaved conversations.
 *
 * @example
 * ```typescript
 * const parts: MessagePart[] = [
 *   { type: 'text', text: 'Let me analyze this image:' },
 *   { type: 'image', url: 'https://example.com/image.png', mimeType: 'image/png' },
 *   { type: 'thinking', thinking: 'The image shows...' },
 *   { type: 'text', text: 'Based on the analysis...' }
 * ]
 * ```
 */
export type MessagePart = TextContent | ThinkingContent | ImageContent | ToolCall

// ============================================================================
// AppMessage
// ============================================================================

/**
 * Complete message in the application's conversation model.
 *
 * An AppMessage represents a single turn in the conversation,
 * containing metadata (id, role, timestamp) and an array of content parts.
 *
 * @example
 * ```typescript
 * const userMessage: AppMessage = {
 *   id: 'msg_001',
 *   role: 'user',
 *   content: [
 *     { type: 'text', text: 'What is in this image?' },
 *     { type: 'image', url: 'https://example.com/photo.jpg' }
 *   ],
 *   createdAt: Date.now()
 * }
 *
 * const assistantMessage: AppMessage = {
 *   id: 'msg_002',
 *   role: 'assistant',
 *   content: [
 *     { type: 'thinking', thinking: 'Analyzing the image...' },
 *     { type: 'text', text: 'The image shows a sunset over mountains.' }
 *   ],
 *   createdAt: Date.now()
 * }
 * ```
 */
export interface AppMessage {
  /** Unique identifier for this message */
  readonly id: string
  /** Role of the message sender */
  readonly role: MessageRole
  /** Array of content parts comprising the message */
  readonly content: MessagePart[]
  /** Unix timestamp (milliseconds) when the message was created */
  readonly createdAt: number
}
