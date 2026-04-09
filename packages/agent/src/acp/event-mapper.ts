/**
 * Maps RuntimeEvent to ACP SessionUpdate notifications.
 *
 * 将 tianji runtime 事件流转换为 ACP 协议的 session/update 通知。
 * Run lifecycle 事件不映射为 SessionUpdate，因为 ACP 的 prompt() 返回值已隐含结束语义。
 *
 * @module acp/event-mapper
 */

import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { RuntimeEvent } from '@tianji/shared'

/**
 * 将单个 RuntimeEvent 映射为 ACP SessionUpdate 通知。
 * 不可映射的事件返回 null。
 */
export function mapRuntimeEventToSessionUpdate(
  sessionId: string,
  event: RuntimeEvent
): SessionNotification | null {
  switch (event.type) {
    case 'message.delta':
      return {
        sessionId,
        update: {
          sessionUpdate:
            event.channel === 'thinking' ? 'agent_thought_chunk' : 'agent_message_chunk',
          content: {
            type: 'text',
            text: event.payload.content,
          },
        },
      }

    case 'tool.started':
      return {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: event.toolCallId,
          title: event.invocation.toolName,
          kind: mapToolKind(event.invocation.toolName),
          status: 'pending',
          rawInput: event.invocation.args,
        },
      }

    case 'tool.completed':
      return {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolCallId,
          status: 'completed',
        },
      }

    case 'tool.failed':
      return {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolCallId,
          status: 'failed',
        },
      }

    case 'message.started':
    case 'message.completed':
    case 'run.started':
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
    // Graph 编排事件属于顶层观测层，不映射为 ACP session update。
    case 'graph.started':
    case 'graph.node.started':
    case 'graph.node.completed':
    case 'graph.node.failed':
    case 'graph.completed':
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
