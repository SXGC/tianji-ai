import { describe, expect, it, vi } from 'vitest'
import { BatchCommitter } from '../batch-committer.js'

/** 等待所有挂起的微任务完成（对于多层 .then() chain 需要多次 await）。 */
async function flushMicrotasks(): Promise<void> {
  // flushChain 最多有 2 层 .then()，3 次 await Promise.resolve() 足够
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('BatchCommitter', () => {
  it('到达 maxItems 立即 flush', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const c = new BatchCommitter<number>({ maxItems: 3, flushIntervalMs: 10_000, flush })
    c.push(1)
    c.push(2)
    expect(flush).not.toHaveBeenCalled()
    c.push(3)
    await flushMicrotasks()
    expect(flush).toHaveBeenCalledWith([1, 2, 3])
    await c.dispose()
  })

  it('到达 flushIntervalMs 触发 flush', async () => {
    vi.useFakeTimers()
    const flush = vi.fn().mockResolvedValue(undefined)
    const c = new BatchCommitter<number>({ maxItems: 100, flushIntervalMs: 50, flush })
    c.push(7)
    vi.advanceTimersByTime(50)
    await flushMicrotasks()
    expect(flush).toHaveBeenCalledWith([7])
    await c.dispose()
    vi.useRealTimers()
  })

  it('dispose 前还有 buffer 时 final flush', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const c = new BatchCommitter<number>({ maxItems: 100, flushIntervalMs: 10_000, flush })
    c.push(1)
    await c.dispose()
    expect(flush).toHaveBeenCalledWith([1])
  })

  it('flush 失败时通过 onFlushError 传播错误', async () => {
    const flushError = new Error('store unavailable')
    const flush = vi.fn().mockRejectedValue(flushError)
    const onFlushError = vi.fn()
    const c = new BatchCommitter<number>({
      maxItems: 1,
      flushIntervalMs: 10_000,
      flush,
      onFlushError,
    })
    c.push(42)
    await flushMicrotasks()
    expect(onFlushError).toHaveBeenCalledOnce()
    const [err, items] = onFlushError.mock.calls[0]
    expect(err).toBe(flushError)
    expect(items).toEqual([42])
    await c.dispose()
  })

  it('push after dispose 抛出明确错误', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const c = new BatchCommitter<number>({ maxItems: 100, flushIntervalMs: 10_000, flush })
    await c.dispose()
    expect(() => c.push(1)).toThrow('BatchCommitter: already disposed')
  })

  it('dispose 等待 in-flight flush 完成后再 final flush', async () => {
    const order: string[] = []
    let resolveFirst!: () => void
    const firstFlushDone = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })

    const flush = vi
      .fn()
      .mockImplementationOnce(async () => {
        // 第一次 flush 挂起，等待外部 resolve
        await firstFlushDone
        order.push('first-flush-done')
      })
      .mockImplementationOnce(async () => {
        order.push('second-flush-done')
      })

    const c = new BatchCommitter<number>({ maxItems: 1, flushIntervalMs: 10_000, flush })
    c.push(1) // 触发第一次 flush（挂起中）

    await flushMicrotasks() // 等待 chain 开始执行（first flush 开始但挂起）

    c.push(2) // 进入 buffer，等待 dispose 时 final flush

    // 启动 dispose（应该等待 flushChain + final flush）
    const disposePromise = c.dispose()

    // 释放第一次 flush
    resolveFirst()
    await disposePromise

    expect(order).toEqual(['first-flush-done', 'second-flush-done'])
  })
})
