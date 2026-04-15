/**
 * Maps ACP SessionUpdate notifications to DomainEventEnvelope.
 *
 * @module acp/event-adapter
 */

import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { DomainEvent, DomainEventEnvelope, RunId } from '@tianji/shared'

let deltaSequence = 0

/**
 * 将 ACP SessionUpdate 通知映射为 DomainEventEnvelope。不可映射时返回 null。
 *
 * 生成的 envelope aggregateType 固定为 'Run'，aggregateId 为传入的 runId。
 */
export function mapSessionUpdateToRuntimeEvent(
  notification: SessionNotification,
  runId: RunId
): DomainEventEnvelope | null {
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
      return wrapRunEvent(event, runId, now)
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
      return wrapRunEvent(event, runId, now)
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
      return wrapRunEvent(event, runId, now)
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
        return wrapRunEvent(event, runId, now)
      }
      return null
    }

    default:
      return null
  }
}

/**
 * 将 DomainEvent 包装为 Run 聚合的 DomainEventEnvelope。
 * source.processKind 固定为 'node'，表示 node 进程侧。
 */
function wrapRunEvent(event: DomainEvent, runId: RunId, now: number): DomainEventEnvelope {
  return {
    eventId: `acp_${event.type}_${now}`,
    type: event.type,
    occurredAt: new Date(now).toISOString(),
    correlationId: String(runId),
    causationId: null,
    sequence: 0,
    aggregateType: 'Run',
    aggregateId: String(runId),
    source: { processKind: 'node', processId: String(process.pid) },
    payload: event,
  }
}

function extractText(content: { type: string; text?: string }): string {
  return content.type === 'text' && typeof content.text === 'string' ? content.text : ''
}
