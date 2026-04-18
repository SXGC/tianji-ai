import { describe, expect, it, vi } from 'vitest'

import { createGraphRuntime } from '../runtime/graph-runtime.js'

describe('createGraphRuntime', () => {
  it('creates session and emits runtime-controlled graph events', async () => {
    const sessionRuntime = {
      createSession: vi.fn(async () => ({ sessionId: 'session_1' })),
      openSession: vi.fn(async () => ({ sessionId: 'session_1' })),
      streamEvents: vi.fn(() => (async function* () {})()),
      cancelRun: vi.fn(),
    }

    const runtime = createGraphRuntime({
      sessionRuntime: sessionRuntime as never,
      graphRunner: {
        start: vi.fn(async () => 'run_1'),
      },
    })
    const handle = await runtime.runGraph({
      graph: {
        id: 'g',
        name: 'g',
        version: 1,
        source: 'static',
        locked: false,
        state: {},
        nodes: [],
        edges: [],
      },
      executors: {},
    })

    expect(handle.sessionId).toBe('session_1')
    expect(sessionRuntime.createSession).toHaveBeenCalled()
  })

  it('opens an existing session before falling back to create semantics', async () => {
    const sessionRuntime = {
      createSession: vi.fn(async () => ({ sessionId: 'session_existing' })),
      openSession: vi.fn(async () => ({ sessionId: 'session_existing' })),
      streamEvents: vi.fn(() => (async function* () {})()),
      cancelRun: vi.fn(),
    }

    const runtime = createGraphRuntime({
      sessionRuntime: sessionRuntime as never,
    })

    const handle = await runtime.runGraph({
      graph: {
        id: 'g',
        name: 'g',
        version: 1,
        source: 'static',
        locked: false,
        state: {},
        nodes: [],
        edges: [],
      },
      sessionId: 'session_existing',
      executors: {},
    })

    expect(handle.sessionId).toBe('session_existing')
    expect(sessionRuntime.openSession).toHaveBeenCalledWith('session_existing')
    expect(sessionRuntime.createSession).not.toHaveBeenCalled()
  })
})
