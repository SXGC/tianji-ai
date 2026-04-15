/**
 * 批量提交器：maxItems 满 or flushIntervalMs 到，触发 flush。
 * @module storage/batch-committer
 */

export interface BatchCommitterOptions<T> {
  readonly maxItems: number
  readonly flushIntervalMs: number
  readonly flush: (items: readonly T[]) => Promise<void>
}

export class BatchCommitter<T> {
  private buffer: T[] = []
  private timer: NodeJS.Timeout | null = null
  private disposed = false

  constructor(private readonly options: BatchCommitterOptions<T>) {}

  push(item: T): void {
    if (this.disposed) throw new Error('BatchCommitter: already disposed')
    this.buffer.push(item)
    if (this.buffer.length >= this.options.maxItems) {
      void this.flushNow()
      return
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => {
        void this.flushNow()
      }, this.options.flushIntervalMs)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer.length > 0) await this.flushNow()
  }

  private async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer.length === 0) return
    const items = this.buffer
    this.buffer = []
    await this.options.flush(items)
  }
}
