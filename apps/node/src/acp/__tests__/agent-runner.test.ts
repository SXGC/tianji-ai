import { describe, expect, it, vi } from 'vitest'

import type { AgentRunnerConfig } from '../agent-runner.js'
import { AgentRunner } from '../agent-runner.js'

describe('AgentRunner', () => {
  it('should be constructable with config', () => {
    const config: AgentRunnerConfig = {
      agentId: 'default',
    }

    const runner = new AgentRunner(config)

    expect(runner.agentId).toBe('default')
  })

  it('should expose agentId', () => {
    const runner = new AgentRunner({
      agentId: 'claude-code',
    })

    expect(runner.agentId).toBe('claude-code')
  })

  it('connect throws explicit legacy-shell error', async () => {
    const runner = new AgentRunner({ agentId: 'legacy-agent' })

    await expect(runner.connect()).rejects.toThrow(
      'AgentRunner can no longer be used as a mainline entry; use unified entry'
    )
  })

  it('query throws explicit legacy-shell error', async () => {
    const runner = new AgentRunner({ agentId: 'legacy-agent' })

    const iterator = runner.query('hello')[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow(
      'AgentRunner can no longer be used as a mainline entry; use unified entry'
    )
  })

  it('disconnect keeps legacy shell harmless', async () => {
    const logDebug = vi.fn(async () => undefined)
    const runner = new AgentRunner({
      agentId: 'legacy-agent',
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
      { agentId: 'legacy-agent' }
    )
  })
})
