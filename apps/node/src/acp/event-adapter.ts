/**
 * Maps ACP SessionUpdate notifications to DomainEvent.
 *
 * @module acp/event-adapter
 */

import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { DomainEvent, RunId } from '@tianji/shared'

let deltaSequence = 0

/**
 * 将 ACP SessionUpdate 通知映射为 DomainEvent。不可映射时返回 null。
 */
export function mapSessionUpdateToRuntimeEvent(
  notification: SessionNotification,
  runId: RunId
): DomainEvent | null {
  const update = notification.update
  const now = Date.now()

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const event: DomainEvent = {
        type: 'MessageDelta',
        runId,
        messageId: `acp_msg_${now}`,
        sequence: deltaSequence++,
        channel: 'text',
        payload: { content: extractText(update.content) },
        timestamp: now,
      }
      return event
    }

    case 'agent_thought_chunk': {
      const event: DomainEvent = {
        type: 'MessageDelta',
        runId,
        messageId: `acp_msg_${now}`,
        sequence: deltaSequence++,
        channel: 'thinking',
        payload: { content: extractText(update.content) },
        timestamp: now,
      }
      return event
    }

    case 'tool_call': {
      const event: DomainEvent = {
        type: 'ToolStarted',
        runId,
        toolCallId: update.toolCallId,
        invocation: {
          toolCallId: update.toolCallId,
          toolName: update.title ?? 'unknown',
          args: update.rawInput ?? {},
        },
        timestamp: now,
      }
      return event
    }

    case 'tool_call_update': {
      if (update.status === 'completed') {
        const event: DomainEvent = {
          type: 'ToolCompleted',
          runId,
          toolCallId: update.toolCallId,
          invocation: {
            toolCallId: update.toolCallId,
            toolName: update.title ?? 'unknown',
            args: {},
          },
          result: {
            toolCallId: update.toolCallId,
            result: '',
          },
          timestamp: now,
        }
        return event
      }
      return null
    }

    default:
      return null
  }
}

function extractText(content: { type: string; text?: string }): string {
  return content.type === 'text' && typeof content.text === 'string' ? content.text : ''
}
