/**
 * OTel 适配器：将 DomainEventEnvelope 映射为 OpenTelemetry span。
 *
 * 只处理以下事件类型：
 *   RunStarted / RunCompleted / RunFailed
 *   ToolStarted / ToolCompleted / ToolFailed
 *
 * envelope 的 correlationId / causationId / eventId 统一写入 span attributes，
 * 保证 tracing 数据可与 event-bus 事件关联。
 *
 * @module tracing/otel-adapter
 */

import type { DomainEventEnvelope } from '@tianji/shared'
import type { EventBus, SubscriptionHandle } from '@tianji/shared'
import type {
  RunCompletedEvent,
  RunFailedEvent,
  RunStartedEvent,
  ToolCompletedEvent,
  ToolFailedEvent,
  ToolStartedEvent,
} from '@tianji/shared'

import { startRunSpan, startToolSpan } from './spans.js'

/** OTel 适配器订阅的事件类型过滤器 */
const OTEL_ADAPTER_FILTER = {
  type: [
    'RunStarted',
    'RunCompleted',
    'RunFailed',
    'ToolStarted',
    'ToolCompleted',
    'ToolFailed',
  ] as const,
} as const

/**
 * envelope 公共字段映射到 span attributes。
 * 所有适配的 span 都会携带这三个字段，方便关联 event-bus 事件。
 */
function buildEnvelopeAttributes(env: DomainEventEnvelope): Record<string, string> {
  const attrs: Record<string, string> = {
    'tianji.event.id': env.eventId,
    'tianji.event.correlation_id': env.correlationId,
  }

  if (env.causationId !== null) {
    attrs['tianji.event.causation_id'] = env.causationId
  }

  return attrs
}

/**
 * 处理单个 DomainEventEnvelope，产生对应的 OTel span。
 *
 * RunStarted → 启动 run span，立即结束（无时序跟踪场景不持有 span）
 * RunCompleted / RunFailed → 同上
 * ToolStarted / ToolCompleted / ToolFailed → 启动 tool span，立即结束
 *
 * 若 tracing 未初始化，所有 startXxxSpan 均返回 undefined，此函数静默跳过。
 */
export function handleSpanEvent(env: DomainEventEnvelope): void {
  const envelopeAttrs = buildEnvelopeAttributes(env)

  switch (env.type) {
    case 'RunStarted': {
      const payload = env.payload as RunStartedEvent
      const spanResult = startRunSpan({
        runId: payload.runId,
        sessionId: payload.sessionId,
      })
      if (spanResult !== undefined) {
        spanResult.span.setAttributes(envelopeAttrs)
        spanResult.end()
      }
      break
    }

    case 'RunCompleted': {
      const payload = env.payload as RunCompletedEvent
      const spanResult = startRunSpan({
        runId: payload.runId,
        sessionId: payload.sessionId,
      })
      if (spanResult !== undefined) {
        spanResult.span.setAttributes(envelopeAttrs)
        spanResult.span.setAttributes({ 'tianji.run.status': 'completed' })
        spanResult.end()
      }
      break
    }

    case 'RunFailed': {
      const payload = env.payload as RunFailedEvent
      const spanResult = startRunSpan({
        runId: payload.runId,
        sessionId: payload.sessionId,
      })
      if (spanResult !== undefined) {
        spanResult.span.setAttributes(envelopeAttrs)
        spanResult.span.setAttributes({
          'tianji.run.status': 'failed',
          'tianji.run.error_code': payload.error.code,
        })
        spanResult.end()
      }
      break
    }

    case 'ToolStarted': {
      const payload = env.payload as ToolStartedEvent
      const spanResult = startToolSpan({
        toolName: payload.invocation.toolName,
        runId: payload.runId,
      })
      if (spanResult !== undefined) {
        spanResult.span.setAttributes(envelopeAttrs)
        spanResult.span.setAttributes({
          'tianji.tool.call_id': payload.toolCallId,
        })
        spanResult.end()
      }
      break
    }

    case 'ToolCompleted': {
      const payload = env.payload as ToolCompletedEvent
      const spanResult = startToolSpan({
        toolName: payload.invocation.toolName,
        runId: payload.runId,
      })
      if (spanResult !== undefined) {
        spanResult.span.setAttributes(envelopeAttrs)
        spanResult.span.setAttributes({
          'tianji.tool.call_id': payload.toolCallId,
          'tianji.tool.status': 'completed',
        })
        spanResult.end()
      }
      break
    }

    case 'ToolFailed': {
      const payload = env.payload as ToolFailedEvent
      const spanResult = startToolSpan({
        toolName: payload.invocation.toolName,
        runId: payload.runId,
      })
      if (spanResult !== undefined) {
        spanResult.span.setAttributes(envelopeAttrs)
        spanResult.span.setAttributes({
          'tianji.tool.call_id': payload.toolCallId,
          'tianji.tool.status': 'failed',
          'tianji.tool.error_code': payload.error.code,
        })
        spanResult.end()
      }
      break
    }

    default:
      break
  }
}

/**
 * 将 OTel 适配器注册到 EventBus，订阅指定事件类型。
 *
 * @param bus - 已初始化的 EventBus 实例
 * @returns SubscriptionHandle，可调用 unsubscribe() 取消订阅
 *
 * @example
 * ```ts
 * const handle = subscribeOtelAdapter(bus)
 * // 停止时：
 * handle.unsubscribe()
 * ```
 */
export function subscribeOtelAdapter(bus: EventBus): SubscriptionHandle {
  return bus.subscribe(OTEL_ADAPTER_FILTER, (env) => handleSpanEvent(env), { name: 'otel-adapter' })
}
