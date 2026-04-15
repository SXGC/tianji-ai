/**
 * 从 EventLogStore 适配 SequenceRecoverer。
 * 此处内联 SequenceRecoverer 结构类型以避免 controlplane 引入 @tianji/runtime 重量级依赖。
 * 装配层注入时 TypeScript 结构检查保证与 @tianji/runtime 侧 SequenceRecoverer 接口兼容。
 * @module storage/event-log-recoverer
 */

import type { AggregateType, EventLogStore } from '@tianji/shared'

/** 与 @tianji/runtime SequenceRecoverer 结构兼容的本地接口定义。 */
interface SequenceRecoverer {
  maxSequence(aggregateType: AggregateType, aggregateId: string): Promise<number | null>
}

/**
 * 从 EventLogStore 创建 SequenceRecoverer。
 * 在进程启动或接管聚合时，用于从 event_log 恢复已持久化的最大 sequence。
 *
 * @param store - EventLogStore 实现
 */
export function createEventLogRecoverer(store: EventLogStore): SequenceRecoverer {
  return {
    async maxSequence(aggregateType: AggregateType, aggregateId: string) {
      return store.maxSequence(aggregateType, aggregateId)
    },
  }
}
