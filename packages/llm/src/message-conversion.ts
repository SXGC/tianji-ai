/**
 * Message conversion utilities.
 * Converts project-owned AppMessage types to AI SDK CoreMessage types.
 */

import type {
  CoreAssistantMessage,
  CoreMessage,
  CoreSystemMessage,
  CoreToolMessage,
  CoreUserMessage,
} from 'ai'
import type {
  AppAssistantMessage,
  AppMessage,
  AppSystemMessage,
  AppToolMessage,
  AppUserMessage,
  MessagePart,
  ToolCallPart,
  ToolResultPart,
} from './types.js'

/**
 * Convert a MessagePart to AI SDK compatible format.
 */
function convertMessagePart(
  part: MessagePart,
): CoreAssistantMessage['content'] extends (infer P)[] ? P : never {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'reasoning':
      return { type: 'reasoning', text: part.text }
    case 'image':
      return { type: 'image', image: part.image }
    case 'tool-call':
      return {
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: part.args,
      }
    default: {
      // Exhaustive check
      const _exhaustive: never = part
      throw new Error(`Unknown message part type: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/**
 * Convert AppUserMessage to AI SDK CoreUserMessage.
 */
function convertUserMessage(message: AppUserMessage): CoreUserMessage {
  if (typeof message.content === 'string') {
    return { role: 'user', content: message.content }
  }

  // Convert array of parts
  const parts = message.content.map((part) => {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text }
      case 'image':
        return { type: 'image', image: part.image }
      default:
        // User messages shouldn't have tool-call or reasoning parts
        throw new Error(`Unexpected part type in user message: ${(part as MessagePart).type}`)
    }
  })

  return { role: 'user', content: parts }
}

/**
 * Convert AppAssistantMessage to AI SDK CoreAssistantMessage.
 */
function convertAssistantMessage(message: AppAssistantMessage): CoreAssistantMessage {
  if (typeof message.content === 'string') {
    return { role: 'assistant', content: message.content }
  }

  // Convert array of parts
  const parts = message.content.map(convertMessagePart)

  return { role: 'assistant', content: parts }
}

/**
 * Convert AppSystemMessage to AI SDK CoreSystemMessage.
 */
function convertSystemMessage(message: AppSystemMessage): CoreSystemMessage {
  return { role: 'system', content: message.content }
}

/**
 * Convert AppToolMessage to AI SDK CoreToolMessage.
 */
function convertToolMessage(message: AppToolMessage): CoreToolMessage {
  const content = message.content.map((part) => ({
    type: 'tool-result' as const,
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    result: part.result,
    isError: part.isError,
  }))

  return { role: 'tool', content }
}

/**
 * Convert a single AppMessage to AI SDK CoreMessage.
 * @param message - The AppMessage to convert
 * @returns The converted CoreMessage
 */
export function appMessageToCoreMessage(message: AppMessage): CoreMessage {
  switch (message.role) {
    case 'user':
      return convertUserMessage(message)
    case 'assistant':
      return convertAssistantMessage(message)
    case 'system':
      return convertSystemMessage(message)
    case 'tool':
      return convertToolMessage(message)
    default: {
      // Exhaustive check
      const _exhaustive: never = message
      throw new Error(`Unknown message role: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/**
 * Convert an array of AppMessages to AI SDK CoreMessages.
 * @param messages - The AppMessages to convert
 * @returns The converted CoreMessages
 */
export function appMessagesToCoreMessages(messages: AppMessage[]): CoreMessage[] {
  return messages.map(appMessageToCoreMessage)
}
