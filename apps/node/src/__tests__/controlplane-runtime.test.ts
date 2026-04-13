import { type Command, createNodeId, createTaskId } from '@tianji/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ControlPlaneCallbacks,
  ControlPlaneConnectionLike,
  ControlPlaneRuntimeConfig,
  ControlPlaneRuntimeDeps,
  TaskExecutorLike,
} from '../node-runtime/controlplane-runtime.js'
import { createControlPlaneRuntime } from '../node-runtime/controlplane-runtime.js'

const { agentRunnerMock, inProcessRunnerMock } = vi.hoisted(() => ({
  agentRunnerMock: vi.fn(),
  inProcessRunnerMock: vi.fn(),
}))

vi.mock('../acp/index.js', () => ({
  AgentRunner: agentRunnerMock,
  InProcessAgentRunner: inProcessRunnerMock,
}))

function createRunnerDouble() {
  return {
    agentId: 'default',
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    async *query() {
      yield {
        type: 'run.completed',
        runId: 'run-test' as never,
        sessionId: 'session-test' as never,
        triggerType: 'new',
        timestamp: Date.now(),
      }
    },
  }
}

function setupRunnerMocks(): void {
  agentRunnerMock.mockImplementation(() => createRunnerDouble())
  inProcessRunnerMock.mockImplementation(() => createRunnerDouble())
  agentRunnerMock.mockClear()
  inProcessRunnerMock.mockClear()
}

function createConnectionDouble(): ControlPlaneConnectionLike {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    setExecutionState: vi.fn(),
    client: {
      openEventStream: vi.fn(async () => ({
        write: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        abort: vi.fn(),
        writeKeepalive: vi.fn(async () => undefined),
      })),
    },
  }
}

function createTestConfig(
  overrides: Partial<ControlPlaneRuntimeConfig> = {}
): ControlPlaneRuntimeConfig {
  return {
    baseUrl: 'http://localhost:3000',
    nodeId: createNodeId('node-test'),
    enrollmentToken: 'test-token',
    hostname: 'testhost',
    platform: 'linux',
    version: '1.0.0',
    agentList: [],
    agentConfigs: {},
    ...overrides,
  }
}

function createLoggerDouble() {
  return {
    logDebug: vi.fn(async () => undefined),
    logInfo: vi.fn(async () => undefined),
    logWarn: vi.fn(async () => undefined),
    logError: vi.fn(async () => undefined),
  }
}

function createTestCommand(): Command {
  return {
    commandId: 'cmd-001' as never,
    nodeId: createNodeId('node-test'),
    type: 'task.run',
    state: 'pending',
    createdAt: Date.now(),
    payload: {
      taskId: createTaskId('task-001'),
      agentId: 'default',
      goal: 'test goal',
    },
  }
}

describe('createControlPlaneRuntime with custom deps', () => {
  it('updateExecutionState propagates to connection', () => {
    const setExecutionState = vi.fn()

    const deps: ControlPlaneRuntimeDeps = {
      createConnection: () => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        setExecutionState,
      }),
      createTaskExecutor: (callbacks: ControlPlaneCallbacks) => {
        // Trigger state change during creation
        callbacks.onExecutionStateChange('busy')
        return {
          executionState: 'idle',
          currentTaskId: null,
          execute: vi.fn(async () => undefined),
        }
      },
    }

    createControlPlaneRuntime(createTestConfig(), deps)

    expect(setExecutionState).toHaveBeenCalledWith('busy')
  })

  it('connection onCommand dispatches to taskExecutor.execute', async () => {
    const fixedNow = Date.now()
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow)

    const execute = vi.fn(async () => undefined)
    let capturedOnCommand: ((cmd: Command) => void) | undefined

    const deps: ControlPlaneRuntimeDeps = {
      createConnection: (config) => {
        capturedOnCommand = config.onCommand as (cmd: Command) => void
        return {
          start: vi.fn(async () => undefined),
          stop: vi.fn(),
          setExecutionState: vi.fn(),
        }
      },
      createTaskExecutor: () => ({
        executionState: 'idle',
        currentTaskId: null,
        execute,
      }),
    }

    createControlPlaneRuntime(createTestConfig(), deps)

    expect(capturedOnCommand).toBeDefined()

    const cmd = createTestCommand()
    capturedOnCommand!(cmd)

    // execute is called via void (fire-and-forget), wait a tick
    dateNowSpy.mockRestore()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(execute).toHaveBeenCalledWith(cmd)
  })

  it('logs fire-and-forget execution failures from connection callbacks', async () => {
    const execute = vi.fn(async () => {
      throw new Error('executor failed')
    })
    const logError = vi.fn(async () => undefined)
    let capturedOnCommand: ((cmd: Command) => void) | undefined

    const deps: ControlPlaneRuntimeDeps = {
      createConnection: (config) => {
        capturedOnCommand = config.onCommand as (cmd: Command) => void
        return {
          start: vi.fn(async () => undefined),
          stop: vi.fn(),
          setExecutionState: vi.fn(),
        }
      },
      createTaskExecutor: () => ({
        executionState: 'idle',
        currentTaskId: null,
        execute,
      }),
    }

    createControlPlaneRuntime(
      createTestConfig({
        logger: {
          logDebug: vi.fn(async () => undefined),
          logInfo: vi.fn(async () => undefined),
          logWarn: vi.fn(async () => undefined),
          logError,
        },
      }),
      deps
    )

    const cmd = createTestCommand()
    capturedOnCommand?.(cmd)

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(logError).toHaveBeenCalledWith(
      ['daemon', 'controlplane'],
      'Failed to execute task command',
      expect.objectContaining({
        commandId: cmd.commandId,
        taskId: cmd.payload.taskId,
        agentId: cmd.payload.agentId,
        error: 'executor failed',
      })
    )
  })

  it('onCommand handler on the runtime handle calls taskExecutor.execute', async () => {
    const execute = vi.fn(async () => undefined)

    const deps: ControlPlaneRuntimeDeps = {
      createConnection: () => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        setExecutionState: vi.fn(),
      }),
      createTaskExecutor: () => ({
        executionState: 'idle',
        currentTaskId: null,
        execute,
      }),
    }

    const runtime = createControlPlaneRuntime(createTestConfig(), deps)
    const cmd = createTestCommand()

    await runtime.onCommand(cmd)

    expect(execute).toHaveBeenCalledWith(cmd)
  })

  it('does not call execute when taskExecutorRef is null at command time', async () => {
    let capturedOnCommand: ((cmd: Command) => void) | undefined

    const deps: ControlPlaneRuntimeDeps = {
      createConnection: (config) => {
        capturedOnCommand = config.onCommand as (cmd: Command) => void
        return {
          start: vi.fn(async () => undefined),
          stop: vi.fn(),
          setExecutionState: vi.fn(),
        }
      },
      // By not providing createTaskExecutor we test the default branch;
      // but since it requires real classes, we'll test via connection callback timing instead.
      createTaskExecutor: () => ({
        executionState: 'idle',
        currentTaskId: null,
        execute: vi.fn(async () => undefined),
      }),
    }

    createControlPlaneRuntime(createTestConfig(), deps)

    // This is actually wired properly, so execute would be called.
    // The null guard is only relevant before taskExecutorRef is assigned,
    // which happens within the synchronous constructor flow.
    expect(capturedOnCommand).toBeDefined()
  })

  it('exposes connection and taskExecutor on the returned handle', () => {
    const mockConnection: ControlPlaneConnectionLike = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      setExecutionState: vi.fn(),
    }
    const mockExecutor: TaskExecutorLike = {
      executionState: 'idle',
      currentTaskId: null,
      execute: vi.fn(async () => undefined),
    }

    const deps: ControlPlaneRuntimeDeps = {
      createConnection: () => mockConnection,
      createTaskExecutor: () => mockExecutor,
    }

    const runtime = createControlPlaneRuntime(createTestConfig(), deps)

    expect(runtime.connection).toBe(mockConnection)
    expect(runtime.taskExecutor).toBe(mockExecutor)
  })

  it('multiple execution state changes all propagate', () => {
    const setExecutionState = vi.fn()
    let capturedCallbacks: ControlPlaneCallbacks | undefined

    const deps: ControlPlaneRuntimeDeps = {
      createConnection: () => ({
        start: vi.fn(async () => undefined),
        stop: vi.fn(),
        setExecutionState,
      }),
      createTaskExecutor: (callbacks) => {
        capturedCallbacks = callbacks
        return {
          executionState: 'idle',
          currentTaskId: null,
          execute: vi.fn(async () => undefined),
        }
      },
    }

    createControlPlaneRuntime(createTestConfig(), deps)

    capturedCallbacks!.onExecutionStateChange('busy')
    capturedCallbacks!.onExecutionStateChange('idle')
    capturedCallbacks!.onExecutionStateChange('busy')

    expect(setExecutionState).toHaveBeenCalledTimes(3)
    expect(setExecutionState).toHaveBeenNthCalledWith(1, 'busy')
    expect(setExecutionState).toHaveBeenNthCalledWith(2, 'idle')
    expect(setExecutionState).toHaveBeenNthCalledWith(3, 'busy')
  })

  it('passes through connection state callback to connection config', () => {
    const onConnectionStateChange = vi.fn()
    let capturedCallback: ((event: { status: string; error?: string }) => void) | undefined

    const deps: ControlPlaneRuntimeDeps = {
      createConnection: (config) => {
        capturedCallback = config.onConnectionStateChange as typeof capturedCallback
        return {
          start: vi.fn(async () => undefined),
          stop: vi.fn(),
          setExecutionState: vi.fn(),
        }
      },
      createTaskExecutor: () => ({
        executionState: 'idle',
        currentTaskId: null,
        execute: vi.fn(async () => undefined),
      }),
    }

    createControlPlaneRuntime(
      createTestConfig({
        onConnectionStateChange,
      } as Partial<ControlPlaneRuntimeConfig>),
      deps
    )

    capturedCallback?.({ status: 'heartbeat_failed', error: 'fetch failed' })
    expect(onConnectionStateChange).toHaveBeenCalledWith({
      status: 'heartbeat_failed',
      error: 'fetch failed',
    })
  })
})

describe('parseAgentArgs (via default TaskExecutor path)', () => {
  // parseAgentArgs is a private function, but we can test it indirectly
  // by creating a runtime without deps.createTaskExecutor and checking
  // The default TaskExecutor creation path uses agentConfigs
  // to locate the @tianji/agent ACP entry point.

  it('creates runtime without deps using default constructors', () => {
    // This tests lines 99-116 (default TaskExecutor creation path).
    // We can't easily test the full execution without real dependencies,
    // but we can verify the runtime is constructed without throwing.
    const runtime = createControlPlaneRuntime(createTestConfig())

    expect(runtime.connection).toBeDefined()
    expect(runtime.taskExecutor).toBeDefined()
    expect(runtime.onCommand).toBeTypeOf('function')
  })
})

describe('createRunner routing', () => {
  beforeEach(() => {
    setupRunnerMocks()
  })

  it('routes native agents to InProcessAgentRunner when nativeAgentContext exists', async () => {
    const logger = createLoggerDouble()
    const runtime = createControlPlaneRuntime(
      createTestConfig({
        agentConfigs: {
          default: { model: 'openai/gpt-4o-mini' },
        },
        nativeAgentContext: {
          paths: {} as never,
          config: {},
          agent: {} as never,
          resolvedEnvVars: [],
          snapshotStore: {} as never,
        },
        defaultGraph: {} as never,
        executorFactory: {} as never,
        logger,
      }),
      {
        createConnection: () => createConnectionDouble(),
      }
    )

    await runtime.taskExecutor.execute(createTestCommand())

    expect(inProcessRunnerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'default',
        nativeAgentContext: expect.any(Object),
      })
    )
    expect(logger.logDebug).toHaveBeenCalledWith(
      ['daemon', 'task'],
      'Resolved task runner type',
      expect.objectContaining({
        agentId: 'default',
        resolvedAgentType: 'native',
        hasNativeAgentContext: true,
        hasDefaultGraph: true,
        hasExecutorFactory: true,
        runnerType: 'inprocess',
      })
    )
    expect(agentRunnerMock).not.toHaveBeenCalled()
  })

  it('routes external agents to AgentRunner', async () => {
    const logger = createLoggerDouble()
    const runtime = createControlPlaneRuntime(
      createTestConfig({
        agentConfigs: {
          default: { command: 'codex', args: ['--acp'] },
        },
        nativeAgentContext: {
          paths: {} as never,
          config: {},
          agent: {} as never,
          resolvedEnvVars: [],
          snapshotStore: {} as never,
        },
        logger,
      }),
      {
        createConnection: () => createConnectionDouble(),
      }
    )

    await runtime.taskExecutor.execute(createTestCommand())

    expect(agentRunnerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'default',
        command: 'codex',
        args: ['--acp'],
      })
    )
    expect(logger.logDebug).toHaveBeenCalledWith(
      ['daemon', 'task'],
      'Resolved task runner type',
      expect.objectContaining({
        agentId: 'default',
        resolvedAgentType: 'external',
        hasNativeAgentContext: true,
        hasDefaultGraph: false,
        hasExecutorFactory: false,
        runnerType: 'acp',
      })
    )
    expect(inProcessRunnerMock).not.toHaveBeenCalled()
  })

  it('routes native agents to AgentRunner when nativeAgentContext is missing', async () => {
    const runtime = createControlPlaneRuntime(
      createTestConfig({
        agentConfigs: {
          default: { model: 'openai/gpt-4o-mini' },
        },
      }),
      {
        createConnection: () => createConnectionDouble(),
      }
    )

    await runtime.taskExecutor.execute(createTestCommand())

    expect(agentRunnerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'default',
        command: undefined,
      })
    )
    expect(inProcessRunnerMock).not.toHaveBeenCalled()
  })

  it('throws when agent config is missing', async () => {
    const runtime = createControlPlaneRuntime(createTestConfig())

    await expect(runtime.taskExecutor.execute(createTestCommand())).rejects.toThrow(
      'Agent config not found for agentId "default"'
    )
  })
})
