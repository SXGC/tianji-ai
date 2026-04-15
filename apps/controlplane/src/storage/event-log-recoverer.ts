/**
 * 从 EventLogStore 适配 SequenceRecoverer。
 * 使用 `satisfies` 在编译时验证返回对象符合 @tianji/runtime 的 SequenceRecoverer 接口，
 * 防止接口漂移被静默掩盖。
 * @module storage/event-log-recoverer
 */

import type { SequenceRecoverer } from '@tianji/runtime'
import type { AggregateType, EventLogStore } from '@tianji/shared'

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
  } satisfies SequenceRecoverer
}
