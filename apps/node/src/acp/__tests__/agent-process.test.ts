import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentProcessConfig } from '../agent-process.js'
import { AgentProcessManager } from '../agent-process.js'

describe('AgentProcessManager', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should store agent config on construction', () => {
    const config: AgentProcessConfig = {
      agentId: 'default',
      command: 'tianji-agent',
      args: [],
    }

    const manager = new AgentProcessManager(config)

    expect(manager.agentId).toBe('default')
    expect(manager.isRunning).toBe(false)
  })

  it('should report not running before spawn', () => {
    const config: AgentProcessConfig = {
      agentId: 'default',
      command: 'tianji-agent',
      args: [],
    }

    const manager = new AgentProcessManager(config)

    expect(manager.isRunning).toBe(false)
  })
})
