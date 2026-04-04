/**
 * Message conversion between AppMessage and AI SDK CoreMessage
 *
 * This module provides bidirectional conversion between the application's AppMessage format
 * and the AI SDK's CoreMessage format used for generate calls.
 *
 * Role-specific constraints:
 * - system: only accepts exactly one text part
 * - user: only accepts text | image
 * - assistant: only accepts text | thinking (maps to reasoning) | tool-call
 *
 * Unsupported types that throw ConversionError:
 * - file parts
 * - redacted-reasoning parts
 * - binary image payloads (Uint8Array, ArrayBuffer, Buffer)
 * - reasoning parts with signature (cannot be preserved in AppMessage)
 * - tool-result parts (AppMessage has no tool-result type)
 *
 * @module message-conversion
 */

import type {
  AppMessage,
  ImageContent,
  MessagePart,
  MessageRole,
  TextContent,
  ThinkingContent,
  ToolCall,
} from '@tianji/shared'
import type { CoreMessage } from 'ai'

// ============================================================================
// ConversionError
// ============================================================================

/**
 * Custom error for message conversion failures
 */
export class ConversionError extends Error {
  constructor(
    message: string,
    public readonly cause?: 'unsupported_role' | 'unsupported_part_type' | 'tool_message'
  ) {
    super(message)
    this.name = 'ConversionError'
  }
}

// ============================================================================
// Local type definitions for AI SDK content parts
// ============================================================================

/** AI SDK text content part */
type SdkTextPart = { type: 'text'; text: string }

/** AI SDK image content part (URL or base64 string only, not binary) */
type SdkImagePart = { type: 'image'; image: string | URL; mimeType?: string }

/** AI SDK tool call content part */
type SdkToolCallPart = { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }

/** AI SDK reasoning content part */
type SdkReasoningPart = { type: 'reasoning'; text: string; signature?: string }

/** AI SDK file content part (unsupported) */
type SdkFilePart = { type: 'file'; data: unknown; mimeType: string }

/** AI SDK redacted reasoning content part (unsupported) */
type SdkRedactedReasoningPart = { type: 'redacted-reasoning'; data: string }

/** AI SDK tool result content part (unsupported) */
type SdkToolResultPart = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  result: unknown
}

// ============================================================================
// AppMessage → CoreMessage Conversion
// ============================================================================

/**
 * Convert AppMessage content parts to AI SDK content parts for USER role.
 * Only supports text and image parts for user messages.
 */
function convertUserPartsToSdk(parts: MessagePart[]): Array<SdkTextPart | SdkImagePart> {
  const result: Array<SdkTextPart | SdkImagePart> = []

  for (const part of parts) {
    switch (part.type) {
      case 'text':
        result.push({ type: 'text', text: part.text })
        break
      case 'image':
        result.push({
          type: 'image',
          image: part.url,
          mimeType: part.mimeType,
        })
        break
      case 'thinking':
        throw new ConversionError(
          'User message cannot contain thinking parts',
          'unsupported_part_type'
        )
      case 'tool-call':
        throw new ConversionError(
          'User message cannot contain tool-call parts',
          'unsupported_part_type'
        )
      default: {
        const exhaustiveCheck: never = part
        throw new ConversionError(
          `Unsupported message part type: ${JSON.stringify(exhaustiveCheck)}`,
          'unsupported_part_type'
        )
      }
    }
  }

  return result
}

/**
 * Convert AppMessage content parts to AI SDK content parts for ASSISTANT role.
 * Only supports text, thinking (maps to reasoning), and tool-call parts.
 */
function convertAssistantPartsToSdk(
  parts: MessagePart[]
): Array<SdkTextPart | SdkReasoningPart | SdkToolCallPart> {
  const result: Array<SdkTextPart | SdkReasoningPart | SdkToolCallPart> = []

  for (const part of parts) {
    switch (part.type) {
      case 'text':
        result.push({ type: 'text', text: part.text })
        break
      case 'thinking':
        // Map thinking to reasoning (AI SDK's closest equivalent)
        result.push({
          type: 'reasoning',
          text: part.thinking,
        })
        break
      case 'tool-call':
        result.push({
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          args: part.args,
        })
        break
      case 'image':
        throw new ConversionError(
          'Assistant message cannot contain image parts',
          'unsupported_part_type'
        )
      default: {
        const exhaustiveCheck: never = part
        throw new ConversionError(
          `Unsupported message part type: ${JSON.stringify(exhaustiveCheck)}`,
          'unsupported_part_type'
        )
      }
    }
  }

  return result
}

/**
 * Convert a single AppMessage into AI SDK CoreMessage.
 * Throws ConversionError for unsupported roles or part types.
 */
export function appMessageToSdkMessage(message: AppMessage): CoreMessage {
  switch (message.role) {
    case 'system': {
      // System message content must be a single text part for lossless conversion
      if (message.content.length !== 1 || message.content[0].type !== 'text') {
        throw new ConversionError(
          'System message content must be a single text part for CoreMessage conversion',
          'unsupported_part_type'
        )
      }
      const textPart = message.content[0] as TextContent // NOSONAR
      return {
        role: 'system',
        content: textPart.text,
      } as CoreMessage
    }
    case 'user': {
      const content = convertUserPartsToSdk(message.content)
      return {
        role: 'user',
        content,
      } as CoreMessage
    }
    case 'assistant': {
      const content = convertAssistantPartsToSdk(message.content)
      return {
        role: 'assistant',
        content,
      } as CoreMessage
    }
    default: {
      // This branch should never be reached for valid AppMessage roles
      // But tests may pass invalid roles by bypassing TypeScript
      throw new ConversionError(
        `Unsupported message role: ${(message as { role: string }).role}`,
        'unsupported_role'
      )
    }
  }
}

/**
 * Convert multiple AppMessages into AI SDK CoreMessages.
 */
export function appMessagesToSdkMessages(messages: readonly AppMessage[]): CoreMessage[] {
  return messages.map((msg) => appMessageToSdkMessage(msg))
}

// ============================================================================
// CoreMessage → AppMessage Conversion
// ============================================================================

/**
 * Check if value is a valid URL-safe image (string or URL object).
 * Rejects binary data (Uint8Array, ArrayBuffer, Buffer).
 */
function isUrlSafeImage(image: unknown): image is string | URL {
  return typeof image === 'string' || image instanceof URL
}

/**
 * Type guard for SDK text part.
 */
function isSdkTextPart(part: unknown): part is SdkTextPart {
  return typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
}

/**
 * Type guard for SDK tool call part.
 */
function isSdkToolCallPart(part: unknown): part is SdkToolCallPart {
  if (typeof part !== 'object' || part === null) return false
  const p = part as { type?: unknown; toolCallId?: unknown; toolName?: unknown }
  return (
    p.type === 'tool-call' && typeof p.toolCallId === 'string' && typeof p.toolName === 'string'
  )
}

/**
 * Type guard for SDK file part (unsupported).
 */
function isSdkFilePart(part: unknown): part is SdkFilePart {
  return typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'file'
}

/**
 * Type guard for SDK redacted reasoning part (unsupported).
 */
function isSdkRedactedReasoningPart(part: unknown): part is SdkRedactedReasoningPart {
  return (
    typeof part === 'object' &&
    part !== null &&
    (part as { type?: unknown }).type === 'redacted-reasoning'
  )
}

/**
 * Type guard for SDK tool result part (unsupported).
 */
function isSdkToolResultPart(part: unknown): part is SdkToolResultPart {
  return (
    typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'tool-result'
  )
}

/**
 * Convert AI SDK text part into AppMessage TextContent.
 */
function convertSdkTextToApp(part: SdkTextPart): TextContent {
  return { type: 'text', text: part.text }
}

/**
 * Convert AI SDK image part into AppMessage ImageContent.
 * Only accepts URL-safe image data (string or URL).
 */
function convertSdkImageToApp(part: SdkImagePart): ImageContent {
  const imageUrl = part.image instanceof URL ? part.image.toString() : part.image

  return {
    type: 'image',
    url: imageUrl,
    mimeType: part.mimeType,
  }
}

/**
 * Convert AI SDK tool call part into AppMessage ToolCall.
 */
function convertSdkToolCallToApp(part: SdkToolCallPart): ToolCall {
  return {
    type: 'tool-call',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    args: part.args,
  }
}

/**
 * Convert AI SDK reasoning part into AppMessage ThinkingContent.
 */
function convertSdkReasoningToApp(part: SdkReasoningPart): ThinkingContent {
  return { type: 'thinking', thinking: part.text }
}

function assertNoUnsupportedUserParts(part: unknown): void {
  if (isSdkFilePart(part)) {
    throw new ConversionError('User message cannot contain file parts', 'unsupported_part_type')
  }
  if (isSdkRedactedReasoningPart(part)) {
    throw new ConversionError(
      'User message cannot contain redacted-reasoning parts',
      'unsupported_part_type'
    )
  }
  if (isSdkToolResultPart(part)) {
    throw new ConversionError(
      'User message cannot contain tool-result parts',
      'unsupported_part_type'
    )
  }
  if (isSdkToolCallPart(part)) {
    throw new ConversionError(
      'User message cannot contain tool-call parts',
      'unsupported_part_type'
    )
  }
}

function convertUserImagePart(part: object): MessagePart {
  const img = (part as { image?: unknown }).image
  if (!isUrlSafeImage(img)) {
    throw new ConversionError(
      'User message image must be URL or string, binary data not supported',
      'unsupported_part_type'
    )
  }
  return convertSdkImageToApp({
    type: 'image',
    image: img,
    mimeType: (part as { mimeType?: string }).mimeType,
  })
}

/**
 * Convert AI SDK user content parts to AppMessage parts.
 * Only supports text and image parts.
 * Throws ConversionError for unsupported part types.
 */
function convertSdkUserPartsToApp(content: unknown[]): MessagePart[] {
  const result: MessagePart[] = []

  for (const part of content) {
    assertNoUnsupportedUserParts(part)

    if (isSdkTextPart(part)) {
      result.push(convertSdkTextToApp(part))
      continue
    }

    if (
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'image'
    ) {
      result.push(convertUserImagePart(part))
      continue
    }

    if (
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'reasoning'
    ) {
      throw new ConversionError(
        'User message cannot contain reasoning parts',
        'unsupported_part_type'
      )
    }

    throw new ConversionError(
      `Unsupported SDK content part type for user: ${JSON.stringify(part)}`,
      'unsupported_part_type'
    )
  }

  return result
}

function assertNoUnsupportedAssistantParts(part: unknown): void {
  if (isSdkFilePart(part)) {
    throw new ConversionError(
      'Assistant message cannot contain file parts',
      'unsupported_part_type'
    )
  }
  if (isSdkRedactedReasoningPart(part)) {
    throw new ConversionError(
      'Assistant message cannot contain redacted-reasoning parts',
      'unsupported_part_type'
    )
  }
  if (isSdkToolResultPart(part)) {
    throw new ConversionError(
      'Assistant message cannot contain tool-result parts',
      'unsupported_part_type'
    )
  }
  if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'image') {
    throw new ConversionError(
      'Assistant message cannot contain image parts',
      'unsupported_part_type'
    )
  }
}

function convertAssistantReasoningPart(part: object): MessagePart {
  if ((part as { signature?: unknown }).signature !== undefined) {
    throw new ConversionError(
      'Assistant message reasoning with signature cannot be converted (signature not supported in AppMessage)',
      'unsupported_part_type'
    )
  }
  if (typeof (part as { text?: unknown }).text !== 'string') {
    throw new ConversionError(
      'Assistant message reasoning must have text field',
      'unsupported_part_type'
    )
  }
  return convertSdkReasoningToApp({ type: 'reasoning', text: (part as { text: string }).text })
}

/**
 * Convert AI SDK assistant content parts to AppMessage parts.
 * Only supports text, reasoning (maps to thinking), and tool-call parts.
 * Throws ConversionError for unsupported part types or reasoning with signature.
 */
function convertSdkAssistantPartsToApp(content: unknown[]): MessagePart[] {
  const result: MessagePart[] = []

  for (const part of content) {
    assertNoUnsupportedAssistantParts(part)

    if (isSdkTextPart(part)) {
      result.push(convertSdkTextToApp(part))
      continue
    }

    if (isSdkToolCallPart(part)) {
      result.push(convertSdkToolCallToApp(part))
      continue
    }

    if (
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'reasoning'
    ) {
      result.push(convertAssistantReasoningPart(part))
      continue
    }

    throw new ConversionError(
      `Unsupported SDK content part type for assistant: ${JSON.stringify(part)}`,
      'unsupported_part_type'
    )
  }

  return result
}

/**
 * Convert AI SDK CoreMessage into AppMessage.
 *
 * Note: This conversion is lossy because:
 * - CoreMessage.id is not preserved (not in CoreMessage)
 * - CoreMessage.providerOptions are not preserved
 * - Tool messages cannot be converted back to AppMessage (throws ConversionError)
 * - Reasoning parts with signature are rejected (signature not supported in AppMessage)
 *
 * @throws ConversionError for tool messages or unsupported content types
 */
export function sdkMessageToAppMessage(
  message: CoreMessage,
  id: string,
  createdAt: number
): AppMessage {
  const content: MessagePart[] = []
  let role: MessageRole

  switch (message.role) {
    case 'system': {
      // System message content is a single string in AI SDK
      if (typeof message.content !== 'string') {
        throw new ConversionError(
          `System message content must be a string, got ${typeof message.content}`,
          'unsupported_part_type'
        )
      }
      content.push({ type: 'text', text: message.content })
      role = 'system'
      break
    }
    case 'user': {
      const userContent = message.content
      if (typeof userContent === 'string') {
        content.push({ type: 'text', text: userContent })
      } else if (Array.isArray(userContent)) {
        const converted = convertSdkUserPartsToApp(userContent)
        content.push(...converted)
      } else {
        throw new ConversionError(
          'User message content must be string or array',
          'unsupported_part_type'
        )
      }
      role = 'user'
      break
    }
    case 'assistant': {
      const assistantContent = message.content
      if (typeof assistantContent === 'string') {
        content.push({ type: 'text', text: assistantContent })
      } else if (Array.isArray(assistantContent)) {
        const converted = convertSdkAssistantPartsToApp(assistantContent)
        content.push(...converted)
      } else {
        throw new ConversionError(
          'Assistant message content must be string or array',
          'unsupported_part_type'
        )
      }
      role = 'assistant'
      break
    }
    case 'tool':
      // Tool messages contain tool results - cannot convert back to AppMessage
      // AppMessage has no tool-result content type
      throw new ConversionError(
        'Tool messages cannot be converted to AppMessage (no tool-result support)',
        'tool_message'
      )
    default: {
      throw new ConversionError(
        `Unsupported CoreMessage role: ${JSON.stringify(message)}`,
        'unsupported_role'
      )
    }
  }

  return {
    id,
    content,
    role,
    createdAt,
  }
}
