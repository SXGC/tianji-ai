import type { MessageDelta } from './delta.js'
import type { MessageDeltaChannel } from './events.js'
import type { AppMessage, MessagePart, TextContent, ThinkingContent } from './message.js'

export interface AggregatedMessageDeltaState {
  readonly message: AppMessage
  readonly lastSequence: number
  readonly completedChannels: Partial<Record<MessageDeltaChannel, true>>
}

function getChannelPartIndex(parts: readonly MessagePart[], channel: MessageDeltaChannel): number {
  return parts.findIndex((part) => part.type === channel)
}

function toChannelPart(channel: MessageDeltaChannel, value: string): TextContent | ThinkingContent {
  if (channel === 'text') {
    return { type: 'text', text: value }
  }

  return { type: 'thinking', thinking: value }
}

function readChannelPartValue(part: MessagePart | undefined, channel: MessageDeltaChannel): string {
  if (part === undefined) {
    return ''
  }

  if (channel === 'text' && part.type === 'text') {
    return part.text
  }

  if (channel === 'thinking' && part.type === 'thinking') {
    return part.thinking
  }

  throw new Error(`Channel ${channel} does not match existing message part type ${part.type}`)
}

function normalizePayload(delta: MessageDelta): string {
  if (typeof delta.payload !== 'string') {
    throw new Error(
      `MessageDelta payload for channel ${delta.channel} must be a string for ${delta.op} operations`
    )
  }

  return delta.payload
}

export function applyMessageDelta(
  current: AggregatedMessageDeltaState | undefined,
  delta: MessageDelta
): AggregatedMessageDeltaState {
  if (current !== undefined && current.message.id !== delta.messageId) {
    throw new Error(
      `Cannot apply delta for message ${delta.messageId} to state for ${current.message.id}`
    )
  }

  if (current !== undefined && delta.sequence <= current.lastSequence) {
    return current
  }

  const baseMessage: AppMessage = current?.message ?? {
    id: delta.messageId,
    role: 'assistant',
    content: [],
    createdAt: delta.timestamp,
  }

  const nextContent = [...baseMessage.content]
  const completedChannels = { ...(current?.completedChannels ?? {}) }

  if (delta.op === 'complete') {
    completedChannels[delta.channel] = true
    return {
      message: baseMessage,
      lastSequence: delta.sequence,
      completedChannels,
    }
  }

  const nextValue = normalizePayload(delta)
  const partIndex = getChannelPartIndex(nextContent, delta.channel)
  const currentPart = partIndex >= 0 ? nextContent[partIndex] : undefined
  const currentValue = readChannelPartValue(currentPart, delta.channel)
  const aggregatedValue = delta.op === 'append' ? `${currentValue}${nextValue}` : nextValue
  const nextPart = toChannelPart(delta.channel, aggregatedValue)

  if (partIndex >= 0) {
    nextContent[partIndex] = nextPart
  } else {
    nextContent.push(nextPart)
  }

  return {
    message: {
      ...baseMessage,
      content: nextContent,
    },
    lastSequence: delta.sequence,
    completedChannels,
  }
}

export function isComplete(state: AggregatedMessageDeltaState | undefined): boolean {
  return state?.completedChannels.text === true
}
