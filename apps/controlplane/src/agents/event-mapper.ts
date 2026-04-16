/**
 * 事件映射器 - 将 DomainEventEnvelope 转换为 AG-UI BaseEvent 序列
 *
 * 纯函数实现，无副作用（ctx 对象上的 inThinking 状态除外，
 * 由调用方在会话生命周期内持有）。
 *
 * @module event-mapper
 */
import { EventType } from '@ag-ui/client'
import type { BaseEvent } from '@ag-ui/client'
import type { DomainEventEnvelope } from '@tianji/shared'

// ============================================================================
// 公共接口
// ============================================================================

export interface EventMapperContext {
  /** 当前是否处于 thinking（推理）流输出状态 */
  inThinking: boolean
  /** 当前 task ID */
  taskId: string
}

// ============================================================================
// 内部类型工具
// ============================================================================

/**
 * 简单 plain-object AG-UI 事件构造辅助，绕过严格类型检查。
 * BaseEvent 使用 passthrough zod schema，允许任意额外字段。
 */
function ev(fields: Record<string, unknown>): BaseEvent {
  return fields as BaseEvent
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 生成初始 STATE_SNAPSHOT 事件，用于首次连接时向客户端推送初始状态。
 */
export function createInitialStateSnapshot(): BaseEvent {
  return ev({
    type: EventType.STATE_SNAPSHOT,
    snapshot: { sessionId: null, taskStatus: null, taskId: null },
  })
}

/**
 * 将单个 DomainEventEnvelope 翻译为一个或多个 AG-UI BaseEvent。
 *
 * @param env - 领域事件信封
 * @param ctx - 调用方持有的映射上下文（inThinking 会被此函数修改）
 * @returns AG-UI 事件数组，顺序即推送顺序
 */
export function mapToAgUi(env: DomainEventEnvelope, ctx: EventMapperContext): BaseEvent[] {
  switch (env.type) {
    // ── Task 聚合 ────────────────────────────────────────────────────────────
    case 'TaskStarted':
      return [
        ev({
          type: EventType.STATE_DELTA,
          delta: [
            { op: 'replace', path: '/taskStatus', value: 'running' },
            { op: 'replace', path: '/taskId', value: ctx.taskId },
          ],
        }),
      ]

    case 'TaskCompleted':
      return [
        ev({
          type: EventType.STATE_DELTA,
          delta: [{ op: 'replace', path: '/taskStatus', value: 'completed' }],
        }),
      ]

    case 'TaskFailed': {
      const failedPayload = env.payload as { error: { message: string } }
      return [
        ev({
          type: EventType.STATE_DELTA,
          delta: [{ op: 'replace', path: '/taskStatus', value: 'failed' }],
        }),
        ev({
          type: EventType.RUN_ERROR,
          message: failedPayload.error.message,
        }),
      ]
    }

    case 'TaskCancelled':
      return [
        ev({
          type: EventType.STATE_DELTA,
          delta: [{ op: 'replace', path: '/taskStatus', value: 'cancelled' }],
        }),
        ev({
          type: EventType.RUN_ERROR,
          message: 'Task cancelled',
        }),
      ]

    case 'TaskSessionAttached': {
      const attachedPayload = env.payload as { sessionId: string }
      return [
        ev({
          type: EventType.STATE_DELTA,
          delta: [{ op: 'replace', path: '/sessionId', value: attachedPayload.sessionId }],
        }),
      ]
    }

    case 'TaskWaiting':
      return [
        ev({
          type: EventType.STATE_DELTA,
          delta: [{ op: 'replace', path: '/taskStatus', value: 'waiting' }],
        }),
      ]

    // ── Run 聚合：消息 ────────────────────────────────────────────────────────
    case 'MessageStarted': {
      const p = env.payload as { messageId: string }
      return [
        ev({
          type: EventType.TEXT_MESSAGE_START,
          messageId: p.messageId,
          role: 'assistant',
        }),
      ]
    }

    case 'MessageDelta': {
      const p = env.payload as { messageId: string; channel: string; payload: { content: string } }
      return mapMessageDelta(p.messageId, p.channel, p.payload.content, ctx)
    }

    case 'MessageCompleted': {
      const p = env.payload as { messageId: string }
      return mapMessageCompleted(p.messageId, ctx)
    }

    // ── Task 聚合：消息（展示链） ───────────────────────────────────────────
    case 'TaskMessageStarted': {
      const p = env.payload as { messageId: string }
      return [
        ev({
          type: EventType.TEXT_MESSAGE_START,
          messageId: p.messageId,
          role: 'assistant',
        }),
      ]
    }

    case 'TaskMessageDelta': {
      const p = env.payload as {
        messageId: string
        channel: string
        payload: { content: string }
      }
      return mapMessageDelta(p.messageId, p.channel, p.payload.content, ctx)
    }

    case 'TaskMessageCompleted': {
      const p = env.payload as { messageId: string }
      return mapMessageCompleted(p.messageId, ctx)
    }

    // ── Run 聚合：工具 ────────────────────────────────────────────────────────
    case 'ToolStarted': {
      const p = env.payload as {
        toolCallId: string
        invocation: { toolName: string; args: unknown }
      }
      return [
        ev({
          type: EventType.TOOL_CALL_START,
          toolCallId: p.toolCallId,
          toolCallName: p.invocation.toolName,
          args: JSON.stringify(p.invocation.args),
        }),
      ]
    }

    case 'ToolCompleted': {
      const p = env.payload as { toolCallId: string; result: { result: unknown } }
      return [
        ev({
          type: EventType.TOOL_CALL_END,
          toolCallId: p.toolCallId,
        }),
        ev({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId: p.toolCallId,
          content: JSON.stringify(p.result.result),
          role: 'tool',
        }),
      ]
    }

    case 'ToolFailed': {
      const p = env.payload as { toolCallId: string; error: { message: string } }
      return [
        ev({
          type: EventType.TOOL_CALL_END,
          toolCallId: p.toolCallId,
          error: p.error.message,
        }),
      ]
    }

    // ── Run 聚合：run 生命周期 ────────────────────────────────────────────────
    case 'RunStarted': {
      const p = env.payload as { runId: string; sessionId: string; triggerType: string }
      return [
        ev({
          type: EventType.STEP_STARTED,
          stepName: `run:${p.runId}`,
          metadata: {
            stepKind: 'run',
            runId: p.runId,
            sessionId: p.sessionId,
            triggerType: p.triggerType,
          },
        }),
      ]
    }

    case 'RunCompleted': {
      const p = env.payload as { runId: string }
      return [
        ev({
          type: EventType.STEP_FINISHED,
          stepName: `run:${p.runId}`,
          metadata: { stepKind: 'run', runId: p.runId },
        }),
      ]
    }

    case 'RunFailed': {
      const p = env.payload as { runId: string; error: unknown }
      return [
        ev({
          type: EventType.STEP_FINISHED,
          stepName: `run:${p.runId}`,
          metadata: { stepKind: 'run', runId: p.runId, error: p.error },
        }),
      ]
    }

    case 'RunCancelled': {
      const p = env.payload as { runId: string }
      return [
        ev({
          type: EventType.STEP_FINISHED,
          stepName: `run:${p.runId}`,
          metadata: { stepKind: 'run', runId: p.runId, cancelled: true },
        }),
      ]
    }

    // ── GraphRun 聚合 ─────────────────────────────────────────────────────────
    case 'GraphRunStarted': {
      const p = env.payload as { graphId: string; graphVersion: number }
      return [
        ev({
          type: EventType.STEP_STARTED,
          stepName: `graph:${p.graphId}`,
          metadata: { stepKind: 'graph', graphId: p.graphId, graphVersion: p.graphVersion },
        }),
      ]
    }

    case 'GraphRunCompleted': {
      const p = env.payload as { graphId: string; finalState: unknown }
      return [
        ev({
          type: EventType.STEP_FINISHED,
          stepName: `graph:${p.graphId}`,
          metadata: { stepKind: 'graph', graphId: p.graphId, finalState: p.finalState },
        }),
      ]
    }

    case 'GraphNodeStarted': {
      const p = env.payload as { graphId: string; nodeId: string; nodeKind: string }
      return [
        ev({
          type: EventType.STEP_STARTED,
          stepName: `graph-node:${p.graphId}:${p.nodeId}`,
          metadata: {
            stepKind: 'graph-node',
            graphId: p.graphId,
            nodeId: p.nodeId,
            nodeKind: p.nodeKind,
          },
        }),
      ]
    }

    case 'GraphNodeCompleted': {
      const p = env.payload as { graphId: string; nodeId: string; output: unknown }
      return [
        ev({
          type: EventType.STEP_FINISHED,
          stepName: `graph-node:${p.graphId}:${p.nodeId}`,
          metadata: {
            stepKind: 'graph-node',
            graphId: p.graphId,
            nodeId: p.nodeId,
            output: p.output,
          },
        }),
      ]
    }

    case 'GraphNodeFailed': {
      const p = env.payload as { graphId: string; nodeId: string; error: unknown }
      return [
        ev({
          type: EventType.STEP_FINISHED,
          stepName: `graph-node:${p.graphId}:${p.nodeId}`,
          metadata: {
            stepKind: 'graph-node',
            graphId: p.graphId,
            nodeId: p.nodeId,
            error: p.error,
          },
        }),
      ]
    }

    // ── 以下事件不映射到 AG-UI ────────────────────────────────────────────────
    // GraphRunFailed/GraphRunCancelled、Session* 、Node*、TaskObservationLost 暂无 AG-UI 映射
    default:
      return []
  }
}

// ============================================================================
// 内部映射辅助
// ============================================================================

/**
 * MessageDelta 映射：按 channel 区分 text / thinking 双通道。
 *
 * @param messageId - 消息 ID
 * @param channel   - 'text' | 'thinking'
 * @param content   - delta 文本
 * @param ctx       - 调用方持有的映射上下文
 */
function mapMessageDelta(
  messageId: string,
  channel: string,
  content: string,
  ctx: EventMapperContext
): BaseEvent[] {
  if (channel === 'thinking') {
    const result: BaseEvent[] = []
    if (!ctx.inThinking) {
      ctx.inThinking = true
      result.push(ev({ type: EventType.REASONING_START, messageId }))
      result.push(ev({ type: EventType.REASONING_MESSAGE_START, messageId }))
    }
    result.push(ev({ type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta: content }))
    return result
  }

  // channel === 'text'
  return [
    ev({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: content,
    }),
  ]
}

/**
 * MessageCompleted 映射：若处于 thinking 状态，先发结束事件再发 TEXT_MESSAGE_END。
 *
 * @param messageId - 消息 ID
 * @param ctx       - 调用方持有的映射上下文
 */
function mapMessageCompleted(messageId: string, ctx: EventMapperContext): BaseEvent[] {
  const result: BaseEvent[] = []

  if (ctx.inThinking) {
    ctx.inThinking = false
    result.push(ev({ type: EventType.REASONING_MESSAGE_END, messageId }))
    result.push(ev({ type: EventType.REASONING_END, messageId }))
  }

  result.push(ev({ type: EventType.TEXT_MESSAGE_END, messageId }))
  return result
}
