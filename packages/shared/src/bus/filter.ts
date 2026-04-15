/**
 * EventBus filter 匹配。多条件 AND 组合。
 * @module bus/filter
 */

import type { DomainEventEnvelope } from '../events/envelope.js'
import type { EventFilter } from './types.js'

/**
 * 判断 envelope 是否满足 filter 的所有条件（AND 语义）。
 * 每个字段若未指定则视为通配。
 */
export function matchFilter(filter: EventFilter, env: DomainEventEnvelope): boolean {
  if (filter.aggregateType && !filter.aggregateType.includes(env.aggregateType)) return false
  if (filter.aggregateId !== undefined && filter.aggregateId !== env.aggregateId) return false
  if (filter.correlationId !== undefined && filter.correlationId !== env.correlationId) return false
  if (filter.type && !filter.type.includes(env.type)) return false
  return true
}
