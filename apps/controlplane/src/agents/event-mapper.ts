/**
 * 事件映射器 - 将 StoredTaskEvent 转换为 AG-UI BaseEvent 序列
 *
 * 纯函数实现，无副作用（ctx 对象上的 inThinking 状态除外，
 * 由调用方在会话生命周期内持有）。
 *
 * @module event-mapper
 */
import { EventType } from '@ag-ui/client'
import type { BaseEvent } from '@ag-ui/client'
import type { StoredTaskEvent } from '../services/event-store.js'

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
 * 将单个 StoredTaskEvent 翻译为一个或多个 AG-UI BaseEvent。
 *
 * @param event - 从数据库读取的任务事件
 * @param ctx   - 调用方持有的映射上下文（inThinking 会被此函数修改）
 * @returns AG-UI 事件数组，顺序即推送顺序
 */
export function mapTaskEventToAgUiEvents(
  event: StoredTaskEvent,
  ctx: EventMapperContext
): BaseEvent[] {
  const parsed: unknown = JSON.parse(event.payload)

  if (event.kind === 'lifecycle') {
    return mapLifecycleEvent(parsed as LifecyclePayload, ctx)
  }

  if (event.kind === 'agent') {
    return mapAgentEvent(parsed as AgentPayload, ctx)
  }

  return []
}

// ============================================================================
// 内部类型（仅供本模块使用）
// ============================================================================

interface LifecyclePayload {
  kind: 'lifecycle'
  taskId: string
  type: string
  sequence: number
  timestamp: number
  sessionId?: string
  runId?: string
  error?: string
  summary?: string
}

interface AgentPayload {
  kind: 'agent'
  taskId: string
  sequence: number
  sessionId: string
  runId: string
  event: RuntimeEventPayload
}

interface RuntimeEventPayload {
  type: string
  [key: string]: unknown
}

// ============================================================================
// lifecycle 事件映射
// ============================================================================

function mapLifecycleEvent(payload: LifecyclePayload, ctx: EventMapperContext): BaseEvent[] {
  switch (payload.type) {
    case 'task.started':
      return [
        ev({
          type: EventType.RUN_STARTED,
          threadId: ctx.taskId,
          runId: ctx.taskId,
        }),
        ev({
          type: EventType.STATE_DELTA,
          delta: [
            { op: 'replace', path: '/taskStatus', value: 'running' },
            { op: 'replace', path: '/taskId', value: ctx.taskId },
          ],
        }),
      ]

    case 'task.completed':
      return [
        ev({
          type: EventType.RUN_FINISHED,
          threadId: ctx.taskId,
          runId: ctx.taskId,
        }),
        ev({
          type: EventType.STATE_DELTA,
          delta: [{ op: 'replace', path: '/taskStatus', value: 'completed' }],
        }),
      ]

    case 'task.failed':
      return [
        ev({
          type: EventType.RUN_ERROR,
          message: payload.error ?? '',
        }),
        ev({
          type: EventType.STATE_DELTA,
          delta: [{ op: 'replace', path: '/taskStatus', value: 'failed' }],
        }),
      ]

    case 'task.cancelled':
      return [
        ev({
          type: EventType.RUN_ERROR,
          message: 'Task cancelled',
        }),
        ev({
          type: EventType.STATE_DELTA,
          delta: [{ op: 'replace', path: '/taskStatus', value: 'cancelled' }],
        }),
      ]

    case 'task.session.attached':
      return [
        ev({
          type: EventType.STATE_DELTA,
          delta: [{ op: 'replace', path: '/sessionId', value: payload.sessionId }],
        }),
      ]

    case 'task.waiting':
      return [
        ev({
          type: EventType.STATE_DELTA,
          delta: [{ op: 'replace', path: '/taskStatus', value: 'waiting' }],
        }),
      ]

    default:
      return []
  }
}

// ============================================================================
// agent 事件映射
// ============================================================================

function mapAgentEvent(payload: AgentPayload, ctx: EventMapperContext): BaseEvent[] {
  const runtimeEvent = payload.event
  switch (runtimeEvent.type) {
    case 'message.started':
      return mapMessageStarted(runtimeEvent)
    case 'message.delta':
      return mapMessageDelta(runtimeEvent, ctx)
    case 'message.completed':
      return mapMessageCompleted(runtimeEvent, ctx)
    case 'tool.started':
      return mapToolStarted(runtimeEvent)
    case 'tool.completed':
      return mapToolCompleted(runtimeEvent)
    case 'tool.failed':
      return mapToolFailed(runtimeEvent)
    case 'run.started':
      return mapRunStarted(runtimeEvent)
    case 'run.completed':
      return mapRunCompleted(runtimeEvent)
    case 'run.failed':
      return mapRunFailed(runtimeEvent)
    case 'run.cancelled':
      return mapRunCancelled(runtimeEvent)
    case 'graph.started':
      return mapGraphStarted(runtimeEvent)
    case 'graph.completed':
      return mapGraphCompleted(runtimeEvent)
    case 'graph.node.started':
      return mapGraphNodeStarted(runtimeEvent)
    case 'graph.node.completed':
      return mapGraphNodeCompleted(runtimeEvent)
    case 'graph.node.failed':
      return mapGraphNodeFailed(runtimeEvent)
    default:
      return []
  }
}

// ============================================================================
// 消息事件映射辅助
// ============================================================================

function mapMessageStarted(e: RuntimeEventPayload): BaseEvent[] {
  return [
    ev({
      type: EventType.TEXT_MESSAGE_START,
      messageId: e.messageId as string,
      role: 'assistant',
    }),
  ]
}

function mapMessageDelta(e: RuntimeEventPayload, ctx: EventMapperContext): BaseEvent[] {
  const messageId = e.messageId as string
  const channel = e.channel as string
  const content = (e.payload as { content: string }).content

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

function mapMessageCompleted(e: RuntimeEventPayload, ctx: EventMapperContext): BaseEvent[] {
  const messageId = e.messageId as string
  const result: BaseEvent[] = []

  if (ctx.inThinking) {
    ctx.inThinking = false
    result.push(ev({ type: EventType.REASONING_MESSAGE_END, messageId }))
    result.push(ev({ type: EventType.REASONING_END, messageId }))
  }

  result.push(ev({ type: EventType.TEXT_MESSAGE_END, messageId }))
  return result
}

// ============================================================================
// 工具调用事件映射辅助
// ============================================================================

function mapToolStarted(e: RuntimeEventPayload): BaseEvent[] {
  const toolCallId = e.toolCallId as string
  const invocation = e.invocation as { toolName: string; args: unknown }
  return [
    ev({
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: invocation.toolName,
      args: JSON.stringify(invocation.args),
    }),
  ]
}

function mapToolCompleted(e: RuntimeEventPayload): BaseEvent[] {
  const toolCallId = e.toolCallId as string
  const result = e.result as unknown
  return [
    ev({
      type: EventType.TOOL_CALL_END,
      toolCallId,
    }),
    ev({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      content: JSON.stringify(result),
      role: 'tool',
    }),
  ]
}

function mapToolFailed(e: RuntimeEventPayload): BaseEvent[] {
  const error = e.error as { message: string }
  return [
    ev({
      type: EventType.TOOL_CALL_END,
      toolCallId: e.toolCallId as string,
      error: error.message,
    }),
  ]
}

// ============================================================================
// run / graph 事件映射辅助
// ============================================================================

function mapRunStarted(e: RuntimeEventPayload): BaseEvent[] {
  return [
    ev({
      type: EventType.STEP_STARTED,
      stepName: `run:${e.runId}`,
      metadata: {
        stepKind: 'run',
        runId: e.runId,
        sessionId: e.sessionId,
        triggerType: e.triggerType,
      },
    }),
  ]
}

function mapRunCompleted(e: RuntimeEventPayload): BaseEvent[] {
  return [
    ev({
      type: EventType.STEP_FINISHED,
      stepName: `run:${e.runId}`,
      metadata: { stepKind: 'run', runId: e.runId },
    }),
  ]
}

function mapGraphStarted(e: RuntimeEventPayload): BaseEvent[] {
  return [
    ev({
      type: EventType.STEP_STARTED,
      stepName: `graph:${e.graphId}`,
      metadata: { stepKind: 'graph', graphId: e.graphId, graphVersion: e.graphVersion },
    }),
  ]
}

function mapGraphNodeStarted(e: RuntimeEventPayload): BaseEvent[] {
  return [
    ev({
      type: EventType.STEP_STARTED,
      stepName: `graph-node:${e.graphId}:${e.nodeId}`,
      metadata: {
        stepKind: 'graph-node',
        graphId: e.graphId,
        nodeId: e.nodeId,
        nodeKind: e.nodeKind,
      },
    }),
  ]
}

function mapGraphNodeCompleted(e: RuntimeEventPayload): BaseEvent[] {
  return [
    ev({
      type: EventType.STEP_FINISHED,
      stepName: `graph-node:${e.graphId}:${e.nodeId}`,
      metadata: {
        stepKind: 'graph-node',
        graphId: e.graphId,
        nodeId: e.nodeId,
        output: e.output,
      },
    }),
  ]
}

function mapRunFailed(e: RuntimeEventPayload): BaseEvent[] {
  return [
    ev({
      type: EventType.STEP_FINISHED,
      stepName: `run:${e.runId}`,
      metadata: { stepKind: 'run', runId: e.runId, error: e.error },
    }),
  ]
}

function mapRunCancelled(e: RuntimeEventPayload): BaseEvent[] {
  return [
    ev({
      type: EventType.STEP_FINISHED,
      stepName: `run:${e.runId}`,
      metadata: { stepKind: 'run', runId: e.runId, cancelled: true },
    }),
  ]
}

function mapGraphCompleted(e: RuntimeEventPayload): BaseEvent[] {
  return [
    ev({
      type: EventType.STEP_FINISHED,
      stepName: `graph:${e.graphId}`,
      metadata: { stepKind: 'graph', graphId: e.graphId, finalState: e.finalState },
    }),
  ]
}

function mapGraphNodeFailed(e: RuntimeEventPayload): BaseEvent[] {
  return [
    ev({
      type: EventType.STEP_FINISHED,
      stepName: `graph-node:${e.graphId}:${e.nodeId}`,
      metadata: {
        stepKind: 'graph-node',
        graphId: e.graphId,
        nodeId: e.nodeId,
        error: e.error,
      },
    }),
  ]
}
