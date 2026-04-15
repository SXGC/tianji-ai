/**
 * Envelope wrapper 工厂。把裸 DomainEvent 包装成 DomainEventEnvelope。
 * 首次看到某 aggregate key 时调用 SequenceRecoverer 初始化计数器（重启恢复）。
 * @module bus/envelope-wrapper
 */

import type {
  AggregateType,
  DomainEvent,
  DomainEventEnvelope,
  EnvelopeSource,
} from '@tianji/shared'
import { ulid } from 'ulid'
import type { CausalContextProvider } from './causal-context-provider.js'
import { resolveTarget } from './event-target.js'
import type { SequenceCounter } from './sequence-counter.js'
import type { SequenceRecoverer } from './sequence-recoverer.js'

export interface EnvelopeWrapperDeps {
  readonly counter: SequenceCounter
  readonly contextProvider: CausalContextProvider
  readonly source: EnvelopeSource
  readonly recoverer: SequenceRecoverer
  /** 返回 ISO 时间字符串；默认 `new Date().toISOString()`，测试时注入固定值。 */
  readonly now?: () => string
}

/**
 * 创建 wrap 函数。
 * wrap 是 async 的，因为首次遇到新 aggregate key 时需要 await recoverer.maxSequence()。
 *
 * **单写者约束**：每个进程只能创建一个 wrapper 实例及其配套 counter；
 * 多实例共用同一 SequenceCounter 会在首次遇到相同 aggregate key 时抛错。
 *
 * @param deps - 注入依赖
 * @returns 异步 wrap 函数
 */
export function createEnvelopeWrapper(
  deps: EnvelopeWrapperDeps
): (event: DomainEvent) => Promise<DomainEventEnvelope> {
  const seen = new Set<string>()
  /** 正在进行中的首次初始化 Promise，防止并发 wrap 造成重复 init。 */
  const initInFlight = new Map<string, Promise<void>>()
  const now = deps.now ?? (() => new Date().toISOString())

  /**
   * 确保 aggregate key 已完成首次 sequence 恢复初始化。
   * 并发调用时，后续调用复用同一 Promise，recoverer.maxSequence 只执行一次。
   */
  function ensureInitialized(
    key: string,
    aggregateType: AggregateType,
    aggregateId: string
  ): Promise<void> | undefined {
    if (seen.has(key)) return undefined

    const existing = initInFlight.get(key)
    if (existing !== undefined) return existing

    const p = (async () => {
      const max = await deps.recoverer.maxSequence(aggregateType, aggregateId)
      if (max !== null) {
        deps.counter.init(key, max)
      }
      seen.add(key)
    })().finally(() => {
      initInFlight.delete(key)
    })

    initInFlight.set(key, p)
    return p
  }

  return async function wrap(event: DomainEvent): Promise<DomainEventEnvelope> {
    const { aggregateType, aggregateId } = resolveTarget(event)
    const key = `${aggregateType}:${aggregateId}`

    await ensureInitialized(key, aggregateType, aggregateId)

    const sequence = deps.counter.next(key)
    const ctx = deps.contextProvider.getCurrent()

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
