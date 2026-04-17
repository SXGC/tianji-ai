import { describe, expect, it, vi } from 'vitest'

import type { OrchestrationGraph } from '../orchestration/index.js'
import { createUnifiedRuntimeEntry } from '../unified-entry.js'

describe('createUnifiedRuntimeEntry', () => {
  it('assembles default graph before delegating to runtime.runGraph', async () => {
    const graph: OrchestrationGraph = {
      id: 'default',
      name: 'default',
      version: 1,
      source: 'static',
      locked: false,
      state: {},
      nodes: [],
      edges: [],
    }
    const loadGraph = vi.fn(async () => graph)
    const createExecutors = vi.fn(() => ({ deepagents: { execute: vi.fn() } }))
    const runGraph = vi.fn(async () => ({
      runId: 'run_1',
      sessionId: 'session_1',
      events: (async function* () {})(),
    }))

    const entry = createUnifiedRuntimeEntry({
      loadDefaultGraph: loadGraph,
      createExecutorRegistry: createExecutors,
      runtime: {
        runGraph,
        resumeGraph: vi.fn(),
        cancelRun: vi.fn(),
        streamRun: vi.fn(),
      },
    })

    await entry.run({ source: 'cli', input: 'hello', agentId: 'demo' })

    expect(loadGraph).toHaveBeenCalledBefore(createExecutors)
    expect(createExecutors).toHaveBeenCalledBefore(runGraph)
    expect(runGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ source: 'cli', input: 'hello', agentId: 'demo' }),
      })
    )
  })
})
