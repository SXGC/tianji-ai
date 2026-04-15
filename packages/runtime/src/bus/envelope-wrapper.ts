/**
 * Envelope wrapper 工厂。把裸 DomainEvent 包装成 DomainEventEnvelope。
 * 首次看到某 aggregate key 时调用 SequenceRecoverer 初始化计数器（重启恢复）。
 * @module bus/envelope-wrapper
 */

import type { DomainEvent, DomainEventEnvelope, EnvelopeSource } from '@tianji/shared'
import { ulid } from 'ulid'
import type { CausalContext } from './causal-context.js'
import { resolveTarget } from './event-target.js'
import type { SequenceCounter } from './sequence-counter.js'
import type { SequenceRecoverer } from './sequence-recoverer.js'

/** 可变引用持有当前 CausalContext 快照，用于在 turn 内传播因果链。 */
export interface CausalContextRef {
  current: CausalContext
}

export interface EnvelopeWrapperDeps {
  readonly counter: SequenceCounter
  readonly context: CausalContextRef
  readonly source: EnvelopeSource
  readonly recoverer: SequenceRecoverer
  /** 返回 ISO 时间字符串；默认 `new Date().toISOString()`，测试时注入固定值。 */
  readonly now?: () => string
}

/**
 * 创建 wrap 函数。
 * wrap 是 async 的，因为首次遇到新 aggregate key 时需要 await recoverer.maxSequence()。
 *
 * @param deps - 注入依赖
 * @returns 异步 wrap 函数
 */
export function createEnvelopeWrapper(
  deps: EnvelopeWrapperDeps
): (event: DomainEvent) => Promise<DomainEventEnvelope> {
  const seen = new Set<string>()
  const now = deps.now ?? (() => new Date().toISOString())

  return async function wrap(event: DomainEvent): Promise<DomainEventEnvelope> {
    const { aggregateType, aggregateId } = resolveTarget(event)
    const key = `${aggregateType}:${aggregateId}`

    // 仅首次调用 recoverer，避免重复查询
    if (!seen.has(key)) {
      seen.add(key)
      const max = await deps.recoverer.maxSequence(aggregateType, aggregateId)
      if (max !== null) {
        deps.counter.init(key, max)
      }
    }

    const sequence = deps.counter.next(key)
    const ctx = deps.context.current

    return {
      eventId: ulid(),
      type: event.type,
      occurredAt: now(),
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      sequence,
      aggregateType,
      aggregateId,
      source: deps.source,
      payload: event,
    }
  }
}
