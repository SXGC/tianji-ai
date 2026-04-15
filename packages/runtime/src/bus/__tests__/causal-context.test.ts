import { describe, expect, it } from 'vitest'
import { CausalContext } from '../causal-context.js'

describe('CausalContext', () => {
  it('root 设置 correlationId 且 causationId 为 null', () => {
    const ctx = CausalContext.root('corr_1')
    expect(ctx.correlationId).toBe('corr_1')
    expect(ctx.causationId).toBeNull()
  })

  it('child 继承 correlationId 并把 causationId 设为传入 eventId', () => {
    const root = CausalContext.root('corr_1')
    const child = root.child('evt_1')
    expect(child.correlationId).toBe('corr_1')
    expect(child.causationId).toBe('evt_1')
  })

  it('child 不修改父上下文', () => {
    const root = CausalContext.root('corr_1')
    root.child('evt_1')
    expect(root.causationId).toBeNull()
  })
})
