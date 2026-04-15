/**
 * EventBus → ObserverLogger 适配器。
 *
 * 订阅全聚合事件（filter: {}），将每条 DomainEventEnvelope 写入
 * ObserverLogger 的 trace 级别日志，JSONL data 包含 envelope 因果链字段与 payload。
 *
 * @module logger/event-bus-adapter
 */

import type { DomainEventEnvelope, EventBus, SubscriptionHandle } from '@tianji/shared'

import type { ObserverLogScope } from './types.js'
import type { ObserverLogger } from './types.js'

/** event-bus 日志条目的 scope */
const EVENT_BUS_SCOPE: ObserverLogScope = ['observer', 'event-bus'] as const

/**
 * 从 DomainEventEnvelope 提取日志所需的结构化字段。
 *
 * @returns 包含 message、scope、data 的日志参数对象，可直接传入 ObserverLogger。
 */
export function formatEnvelopeLog(env: DomainEventEnvelope): {
  message: string
  scope: ObserverLogScope
  data: Record<string, unknown>
} {
  return {
    message: env.type,
    scope: EVENT_BUS_SCOPE,
    data: {
      correlationId: env.correlationId,
      causationId: env.causationId,
      sequence: env.sequence,
      aggregateType: env.aggregateType,
      aggregateId: env.aggregateId,
      payload: env.payload as unknown as Record<string, unknown>,
    },
  }
}

/**
 * 将 ObserverLogger 注册为 EventBus 的全聚合订阅者。
 *
 * 每条事件以 trace 级别写入 logger，data 字段包含：
 * - correlationId / causationId / sequence：因果链追踪
 * - aggregateType / aggregateId：聚合标识
 * - payload：原始事件载荷
 *
 * @param bus    已初始化的 EventBus 实例
 * @param logger 目标 ObserverLogger 实例
 * @returns SubscriptionHandle，可调用 unsubscribe() 取消订阅
 *
 * @example
 * ```ts
 * const handle = subscribeEventBusLogger(bus, logger)
 * // 停止时：
 * handle.unsubscribe()
 * ```
 */
export function subscribeEventBusLogger(bus: EventBus, logger: ObserverLogger): SubscriptionHandle {
  return bus.subscribe(
    {},
    (env) => {
      const { message, scope, data } = formatEnvelopeLog(env)
      void logger.trace(scope, message, data)
    },
    { name: 'observer-logger' }
  )
}
