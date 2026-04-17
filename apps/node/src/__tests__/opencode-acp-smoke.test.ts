/**
 * Smoke test: legacy ACP runner shell now fails explicitly.
 */
import { describe, expect, it } from 'vitest'

import { AgentRunner } from '../acp/agent-runner.js'

describe('ACP legacy shell', () => {
  it('fails fast instead of running ACP through opencode', async () => {
    const runner = new AgentRunner({
      agentId: 'opencode-smoke',
      command: 'opencode',
      args: ['acp'],
    })

    await expect(runner.connect()).rejects.toThrow(
      'AgentRunner can no longer be used as a mainline entry; use unified entry'
    )
  })
})
