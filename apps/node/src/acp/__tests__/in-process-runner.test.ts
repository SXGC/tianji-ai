import { describe, expect, it } from 'vitest'

import { InProcessAgentRunner } from '../in-process-runner.js'

describe('InProcessAgentRunner', () => {
  it('stores agentId from config', () => {
    const runner = new InProcessAgentRunner({
      agentId: 'reviewer',
    })

    expect(runner.agentId).toBe('reviewer')
  })

  it('connect throws explicit legacy-shell error', async () => {
    const runner = new InProcessAgentRunner({
      agentId: 'reviewer',
    })

    await expect(runner.connect()).rejects.toThrow(
      'InProcessAgentRunner can no longer be used as a mainline entry; use unified entry'
    )
  })

  it('query throws explicit legacy-shell error', async () => {
    const runner = new InProcessAgentRunner({
      agentId: 'reviewer',
    })

    const iterator = runner.query('hello')[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow(
      'InProcessAgentRunner can no longer be used as a mainline entry; use unified entry'
    )
  })

  it('disconnect remains a no-op for legacy shell', async () => {
    const runner = new InProcessAgentRunner({
      agentId: 'reviewer',
    })

    await expect(runner.disconnect()).resolves.toBeUndefined()
  })
})
