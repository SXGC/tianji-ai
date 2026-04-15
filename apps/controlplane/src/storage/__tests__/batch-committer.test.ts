import { describe, expect, it, vi } from 'vitest'
import { BatchCommitter } from '../batch-committer.js'

describe('BatchCommitter', () => {
  it('到达 maxItems 立即 flush', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const c = new BatchCommitter<number>({ maxItems: 3, flushIntervalMs: 10_000, flush })
    c.push(1)
    c.push(2)
    expect(flush).not.toHaveBeenCalled()
    c.push(3)
    await Promise.resolve()
    expect(flush).toHaveBeenCalledWith([1, 2, 3])
    c.dispose()
  })

  it('到达 flushIntervalMs 触发 flush', async () => {
    vi.useFakeTimers()
    const flush = vi.fn().mockResolvedValue(undefined)
    const c = new BatchCommitter<number>({ maxItems: 100, flushIntervalMs: 50, flush })
    c.push(7)
    vi.advanceTimersByTime(50)
    await Promise.resolve()
    expect(flush).toHaveBeenCalledWith([7])
    c.dispose()
    vi.useRealTimers()
  })

  it('dispose 前还有 buffer 时 flushSync', async () => {
    const flush = vi.fn().mockResolvedValue(undefined)
    const c = new BatchCommitter<number>({ maxItems: 100, flushIntervalMs: 10_000, flush })
    c.push(1)
    await c.dispose()
    expect(flush).toHaveBeenCalledWith([1])
  })
})
