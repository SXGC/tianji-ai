import { describe, expect, it } from 'vitest'

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
})
