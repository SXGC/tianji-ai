/**
 * 从持久化存储查单聚合 MAX(sequence)。
 * 由装配层在进程启动或接管聚合时调用，用于初始化 SequenceCounter。
 * SQLite 实现在阶段 04 controlplane 侧；runtime 装配时注入。
 * @module bus/sequence-recoverer
 */

import type { AggregateType } from '@tianji/shared'

export interface SequenceRecoverer {
  /**
   * 查询指定聚合实例的已持久化最大 sequence。
   * 若从未持久化（全新聚合），返回 null。
   *
   * @param aggregateType - 聚合类型
   * @param aggregateId - 聚合实例 ID
   */
  maxSequence(aggregateType: AggregateType, aggregateId: string): Promise<number | null>
}

/** 空实现，用于测试或尚未接入持久层的场景。 */
export const NoopSequenceRecoverer: SequenceRecoverer = {
  async maxSequence(): Promise<number | null> {
    return null
  },
}
