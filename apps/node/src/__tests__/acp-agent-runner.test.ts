import { describe, expect, it, vi } from 'vitest'

import { AgentRunner } from '../acp/agent-runner.js'

describe('AgentRunner legacy shell', () => {
  it('stores agentId from config', () => {
    const runner = new AgentRunner({
      agentId: 'test-agent',
      command: 'tianji-agent',
    })

    expect(runner.agentId).toBe('test-agent')
  })

  it('connect fails explicitly for legacy mainline usage', async () => {
    const runner = new AgentRunner({
      agentId: 'test-agent',
      command: 'tianji-agent',
    })

    await expect(runner.connect()).rejects.toThrow(
      'AgentRunner can no longer be used as a mainline entry; use unified entry'
    )
  })

  it('query fails explicitly for legacy mainline usage', async () => {
    const runner = new AgentRunner({
      agentId: 'test-agent',
      command: 'tianji-agent',
    })

    const iter = runner.query('hello')
    await expect(iter[Symbol.asyncIterator]().next()).rejects.toThrow(
      'AgentRunner can no longer be used as a mainline entry; use unified entry'
    )
  })

  it('disconnect is a no-op that only logs legacy shell cleanup', async () => {
    const logDebug = vi.fn(async () => undefined)
    const runner = new AgentRunner({
      agentId: 'test-agent',
      command: 'tianji-agent',
      logger: {
        logDebug,
        logInfo: vi.fn(async () => undefined),
        logWarn: vi.fn(async () => undefined),
        logError: vi.fn(async () => undefined),
      },
    })

    await expect(runner.disconnect()).resolves.toBeUndefined()
    expect(logDebug).toHaveBeenCalledWith(
      ['acp', 'runner'],
      'Ignoring disconnect for legacy runner shell',
      { agentId: 'test-agent' }
    )
  })
})
