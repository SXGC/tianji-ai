/**
 * 批量提交器：maxItems 满 or flushIntervalMs 到，触发 flush。
 *
 * 设计要点：
 * - 单写者队列（`flushChain`）保证同一时刻只有一个 flush 在运行，避免并发写入和 dispose 竞态。
 * - flush 失败时调用 `onFlushError`（调用方负责路由到 errorSink / 日志），然后 chain 仍然 resolve，
 *   避免产生 unhandled promise rejection。
 * - `dispose()` 严格顺序：清定时器 → await flushChain → final flush → 设 disposed 标记。
 * - `push()` 在 disposed 后调用直接抛出。
 * @module util/batch-committer
 */

export interface BatchCommitterOptions<T> {
  readonly maxItems: number
  readonly flushIntervalMs: number
  readonly flush: (items: readonly T[]) => Promise<void>
  /** flush 失败时的回调，用于路由错误到外部 errorSink / 日志。 */
  readonly onFlushError?: (err: unknown, items: readonly T[]) => void
}

export class BatchCommitter<T> {
  private buffer: T[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  /**
   * 串行 flush chain：始终 resolve（失败通过 onFlushError 传递），
   * 保证不产生 unhandled promise rejection。
   */
  private flushChain: Promise<void> = Promise.resolve()

  constructor(private readonly options: BatchCommitterOptions<T>) {}

  /**
   * 向 buffer 推入一个条目。
   * 若 buffer 达到 maxItems，立即追加到 flush chain；否则确保定时器已启动。
   *
   * @throws 若 committer 已 disposed
   */
  push(item: T): void {
    if (this.disposed) throw new Error('BatchCommitter: already disposed')
    this.buffer.push(item)
    if (this.buffer.length >= this.options.maxItems) {
      this.scheduleFlush()
      return
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.scheduleFlush()
      }, this.options.flushIntervalMs)
    }
  }

  /**
   * 释放资源并保证最终 flush 完成。
   * 顺序：清定时器 → await flushChain → final flush → 标记 disposed。
   */
  async dispose(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // flushChain 始终 resolve，直接 await 即可
    await this.flushChain
    // flush 剩余 buffer
    if (this.buffer.length > 0) {
      await this.runFlushDirect()
    }
    this.disposed = true
  }

  /**
   * 将一次 flush 操作追加到串行 chain 末尾。
   * 将当前 buffer snapshot 存入闭包，保证 flush 时不受后续 push 影响。
   * chain 始终 resolve，flush 失败通过 onFlushError 传递。
   */
  private scheduleFlush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const items = this.buffer
    this.buffer = []
    this.flushChain = this.flushChain.then(() => this.runFlushSafe(items))
  }

  /**
   * 执行一次 flush，失败时调用 onFlushError，但始终 resolve（不抛出）。
   * 用于 flushChain 内部，保证 chain 不变成 rejected。
   */
  private async runFlushSafe(items: readonly T[]): Promise<void> {
    try {
      await this.options.flush(items)
    } catch (err) {
      this.options.onFlushError?.(err, items)
      // 故意不 rethrow：让 chain 保持 resolved，避免 unhandled rejection
    }
  }

  /**
   * 直接执行 flush（用于 dispose 的 final flush，失败直接抛出让调用方感知）。
   */
  private async runFlushDirect(): Promise<void> {
    const items = this.buffer
    this.buffer = []
    try {
      await this.options.flush(items)
    } catch (err) {
      this.options.onFlushError?.(err, items)
      throw err
    }
  }
}
