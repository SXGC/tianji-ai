/**
 * Runtime 事件流水线：wrap envelope → publish → 因果链更新。
 *
 * 装配层通过 createRuntimeEventPipeline 把 DomainEvent 发射、
 * 因果链传播、envelope 包裹和总线 publish 组合成单一 emitEvent 入口。
 * @module bus/pipeline
 */

import type { DomainEvent, DomainEventEnvelope, EnvelopeSource } from '@tianji/shared'

import type { CausalContextRef } from './envelope-wrapper.js'
import { createEnvelopeWrapper } from './envelope-wrapper.js'
import type { SequenceCounter } from './sequence-counter.js'
import type { SequenceRecoverer } from './sequence-recoverer.js'

export interface RuntimeEventPipelineDeps {
  readonly publish: (env: DomainEventEnvelope) => void
  readonly counter: SequenceCounter
  readonly contextRef: CausalContextRef
  readonly source: EnvelopeSource
  readonly recoverer: SequenceRecoverer
  /** 覆盖 ISO 时间字符串生成函数；默认 `new Date().toISOString()`，测试时注入固定值。 */
  readonly now?: () => string
}

export interface RuntimeEventPipeline {
  /** 将裸 DomainEvent 包裹为 envelope 并 publish 到总线，同时推进因果链。 */
  emitEvent(event: DomainEvent): Promise<void>
}

/**
 * 创建 Runtime 事件流水线。
 *
 * 内部组合：
 * 1. createEnvelopeWrapper —— 附加 sequence、eventId、因果链字段
 * 2. publish —— 投递到进程内 EventBus
 * 3. contextRef.current = child(eventId) —— 推进因果链，后续事件自动继承
 *
 * @param deps - 依赖注入项（bus.publish、counter、contextRef、source、recoverer）
 */
export function createRuntimeEventPipeline(deps: RuntimeEventPipelineDeps): RuntimeEventPipeline {
  const wrap = createEnvelopeWrapper({
    counter: deps.counter,
    context: deps.contextRef,
    source: deps.source,
    recoverer: deps.recoverer,
    now: deps.now,
  })

  return {
    async emitEvent(event: DomainEvent): Promise<void> {
      const env = await wrap(event)
      deps.publish(env)
      deps.contextRef.current = deps.contextRef.current.child(env.eventId)
    },
  }
}
