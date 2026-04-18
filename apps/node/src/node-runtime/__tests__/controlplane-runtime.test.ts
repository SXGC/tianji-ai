import * as agentModule from '@tianji/agent'
import { type Command, createNodeId, createTaskId } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import type { ControlPlaneRuntimeDeps } from '../controlplane-runtime.js'
import { createControlPlaneRuntime } from '../controlplane-runtime.js'

describe('createControlPlaneRuntime', () => {
  it('should wire command polling to task execution', async () => {
    const command: Command = {
      commandId: 'command-001' as never,
      nodeId: createNodeId('node-001'),
      type: 'task.run',
      state: 'pending',
      createdAt: Date.now(),
      payload: {
        taskId: createTaskId('task-001'),
        agentId: 'default',
        goal: 'hello',
      },
    }

    const execute = vi.fn(async () => undefined)
    const start = vi.fn(async () => undefined)
    const stop = vi.fn(() => undefined)
    const setExecutionState = vi.fn(() => undefined)

    const deps: ControlPlaneRuntimeDeps = {
      createConnection: () => ({
        start,
        stop,
        setExecutionState,
      }),
      createTaskExecutor: (callbacks) => {
        callbacks.onExecutionStateChange('busy')
        return {
          executionState: 'idle',
          currentTaskId: null,
          execute,
          cancel: vi.fn(),
        }
      },
    }

    const runtime = createControlPlaneRuntime(
      {
        baseUrl: 'http://localhost:3000',
        nodeId: createNodeId('node-001'),
        enrollmentToken: 'enroll-token',
        hostname: 'devbox',
        platform: 'linux',
        version: '0.0.1',
        agentList: [],
        agentConfigs: {},
        emitTaskEvent: vi.fn(),
        enterCorrelation: async (_correlationId, fn) => fn(),
      },
      deps
    )

    await runtime.onCommand(command)

    expect(execute).toHaveBeenCalledWith(command)
  })
})

describe('createControlPlaneUnifiedEntry session handling', () => {
  const baseConfig = {
    baseUrl: 'http://localhost:3000',
    nodeId: createNodeId('node-001'),
    enrollmentToken: 'token',
    hostname: 'host',
    platform: 'linux',
    version: '0.0.1',
    agentList: [],
    agentConfigs: { default: { agentName: 'default' } as never },
    emitTaskEvent: vi.fn(),
    enterCorrelation: async (_id: string, fn: () => Promise<void>) => fn(),
    nativeAgentContext: {} as never,
    defaultGraph: {} as never,
    executorFactory: {} as never,
    observerLogger: undefined,
  }

  function makeConnection() {
    return {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      setExecutionState: vi.fn(),
    }
  }

  it('uses ensureAgentSession when sessionIds is provided', async () => {
    const fakeSession = {
      sessionId: 'session_existing' as never,
      queryWithGraph: vi.fn(async function* () {
        yield { runId: 'run-001' } as never
        yield { type: 'GraphRunCompleted', runId: 'run-001', timestamp: Date.now() } as never
      }),
      abort: vi.fn(),
      close: vi.fn(),
    }
    const ensureSpy = vi
      .spyOn(agentModule, 'ensureAgentSession')
      .mockResolvedValue(fakeSession as never)
    vi.spyOn(agentModule, 'buildDefaultGraph').mockResolvedValue({
      graph: {} as never,
      executorFactory: {} as never,
    })

    const command: Command = {
      commandId: 'cmd-001' as never,
      nodeId: createNodeId('node-001'),
      type: 'task.run',
      state: 'pending',
      createdAt: Date.now(),
      payload: {
        taskId: createTaskId('task-001'),
        agentId: 'default',
        goal: 'hello',
        sessionIds: ['session_existing' as never],
      },
    }

    const runtime = createControlPlaneRuntime(
      { ...baseConfig, emitTaskEvent: vi.fn() },
      { createConnection: () => makeConnection() }
    )

    await runtime.onCommand(command)

    expect(ensureSpy).toHaveBeenCalledWith(
      baseConfig.nativeAgentContext,
      'session_existing',
      undefined
    )

    ensureSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('uses createAgentSession when sessionIds is absent', async () => {
    const fakeSession = {
      sessionId: 'session_new' as never,
      queryWithGraph: vi.fn(async function* () {
        yield { runId: 'run-002' } as never
        yield { type: 'GraphRunCompleted', runId: 'run-002', timestamp: Date.now() } as never
      }),
      abort: vi.fn(),
      close: vi.fn(),
    }
    const createSpy = vi
      .spyOn(agentModule, 'createAgentSession')
      .mockResolvedValue(fakeSession as never)
    vi.spyOn(agentModule, 'buildDefaultGraph').mockResolvedValue({
      graph: {} as never,
      executorFactory: {} as never,
    })

    const command: Command = {
      commandId: 'cmd-002' as never,
      nodeId: createNodeId('node-001'),
      type: 'task.run',
      state: 'pending',
      createdAt: Date.now(),
      payload: {
        taskId: createTaskId('task-002'),
        agentId: 'default',
        goal: 'hello without session',
      },
    }

    const runtime = createControlPlaneRuntime(
      { ...baseConfig, emitTaskEvent: vi.fn() },
      { createConnection: () => makeConnection() }
    )

    await runtime.onCommand(command)

    expect(createSpy).toHaveBeenCalled()

    createSpy.mockRestore()
    vi.restoreAllMocks()
  })
})
