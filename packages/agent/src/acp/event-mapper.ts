/**
 * Maps DomainEventEnvelope to ACP SessionUpdate notifications.
 *
 * 将 tianji 领域事件信封流转换为 ACP 协议的 session/update 通知。
 * Run lifecycle 事件不映射为 SessionUpdate，因为 ACP 的 prompt() 返回值已隐含结束语义。
 *
 * @module acp/event-mapper
 */

import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { DomainEventEnvelope } from '@tianji/shared'

/**
 * 将单个 DomainEventEnvelope 映射为 ACP SessionUpdate 通知。
 * 不可映射的事件返回 null。
 *
 * 仅处理 aggregateType='Run' 的事件：MessageDelta、ToolStarted、ToolCompleted、ToolFailed。
 */
export function mapRuntimeEventToSessionUpdate(
  sessionId: string,
  envelope: DomainEventEnvelope
): SessionNotification | null {
  switch (envelope.type) {
    case 'MessageDelta': {
      const ev = envelope.payload
      if (ev.type !== 'MessageDelta') return null
      return {
        sessionId,
        update: {
          sessionUpdate: ev.channel === 'thinking' ? 'agent_thought_chunk' : 'agent_message_chunk',
          content: {
            type: 'text',
            text: ev.payload.content,
          },
        },
      }
    }

    case 'ToolStarted': {
      const ev = envelope.payload
      if (ev.type !== 'ToolStarted') return null
      return {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: ev.toolCallId,
          title: ev.invocation.toolName,
          kind: mapToolKind(ev.invocation.toolName),
          status: 'pending',
          rawInput: ev.invocation.args,
        },
      }
    }

    case 'ToolCompleted': {
      const ev = envelope.payload
      if (ev.type !== 'ToolCompleted') return null
      return {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: ev.toolCallId,
          status: 'completed',
        },
      }
    }

    case 'ToolFailed': {
      const ev = envelope.payload
      if (ev.type !== 'ToolFailed') return null
      return {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: ev.toolCallId,
          status: 'failed',
        },
      }
    }

    case 'MessageStarted':
    case 'MessageCompleted':
    case 'RunStarted':
    case 'RunCompleted':
    case 'RunFailed':
    case 'RunCancelled':
    // Graph 編排事件属于顶层观测层，不映射为 ACP session update。
    case 'GraphRunStarted':
    case 'GraphNodeStarted':
    case 'GraphNodeCompleted':
    case 'GraphNodeFailed':
    case 'GraphRunCompleted':
    case 'GraphRunFailed':
    // Session / Node / Task 事件不映射为 ACP session update。
    case 'SessionCreated':
    case 'SessionResumed':
    case 'SessionClosed':
    case 'NodeRegistered':
    case 'NodeReRegistered':
    case 'NodeMarkedOffline':
    case 'TaskStarted':
    case 'TaskWaiting':
    case 'TaskSessionAttached':
    case 'TaskCompleted':
    case 'TaskFailed':
    case 'TaskCancelled':
    case 'TaskObservationLost':
      return null
  }
}

/** 将 tianji 工具名映射为 ACP ToolKind。 */
function mapToolKind(toolName: string): 'read' | 'edit' | 'execute' | 'search' | 'other' {
  if (toolName.includes('read') || toolName.includes('Read')) {
    return 'read'
  }
  if (toolName.includes('edit') || toolName.includes('Edit') || toolName.includes('write')) {
    return 'edit'
  }
  if (toolName.includes('exec') || toolName.includes('bash') || toolName.includes('shell')) {
    return 'execute'
  }
  if (toolName.includes('search') || toolName.includes('grep') || toolName.includes('find')) {
    return 'search'
  }
  return 'other'
}
