import { describe, expect, it } from 'vitest'
import { SequenceCounter } from '../sequence-counter.js'

describe('SequenceCounter', () => {
  it('未初始化的 key 第一个 next() 返回 1', () => {
    const c = new SequenceCounter()
    expect(c.next('Run:r1')).toBe(1)
    expect(c.next('Run:r1')).toBe(2)
  })

  it('init 后从 init+1 继续', () => {
    const c = new SequenceCounter()
    c.init('Run:r1', 10)
    expect(c.next('Run:r1')).toBe(11)
  })

  it('同一 key 二次 init throw', () => {
    const c = new SequenceCounter()
    c.init('Run:r1', 5)
    expect(() => c.init('Run:r1', 6)).toThrow(/already initialized/)
  })

  it('不同 key 互不影响', () => {
    const c = new SequenceCounter()
    c.next('Run:r1')
    expect(c.next('Run:r2')).toBe(1)
  })
})
