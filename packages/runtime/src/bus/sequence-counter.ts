/**
 * 聚合实例 sequence 内存计数器。
 * key = `${aggregateType}:${aggregateId}`。
 * 进程内单写，无需并发锁（Node.js 单线程事件循环保证 next() 调用不重入）。
 * @module bus/sequence-counter
 */

export class SequenceCounter {
  private readonly counters = new Map<string, number>()
  private readonly initialized = new Set<string>()

  /**
   * 用持久化的 maxSequence 初始化计数器起始值。
   * 同一 key 只能初始化一次，二次调用 throw（Let it crash）。
   *
   * @param key - `${aggregateType}:${aggregateId}`
   * @param from - 已持久化的最大 sequence 值，后续 next() 将从 from+1 开始
   */
  init(key: string, from: number): void {
    if (this.initialized.has(key)) {
      throw new Error(`SequenceCounter: key already initialized: ${key}`)
    }
    this.initialized.add(key)
    this.counters.set(key, from)
  }

  /**
   * 返回下一个 sequence 值并自增。
   * 未 init 的 key 从 1 开始。
   *
   * @param key - `${aggregateType}:${aggregateId}`
   */
  next(key: string): number {
    const current = this.counters.get(key) ?? 0
    const nextVal = current + 1
    this.counters.set(key, nextVal)
    return nextVal
  }
}
