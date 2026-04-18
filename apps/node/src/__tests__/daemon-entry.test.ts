import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentRuntimeOptions, AgentSession, LoadedAgentContext } from '@tianji/agent'
import type { TianjiConfig } from '@tianji/shared'

import type { UserConfigPaths } from '../config.js'
import type { DaemonHandle } from '../daemon-entry.js'

type LoadUserConfigContextResult = {
  paths: UserConfigPaths
  config: TianjiConfig
  agent: {
    agentName: string
    modelRef: string
    provider: string
    modelName: string
    providerConfig: undefined
    soulPath: string
    soul: string
    workspace: undefined
  }
  resolvedEnvVars: readonly string[]
  snapshotStore: object
}

const paths: UserConfigPaths = {
  configDir: '/tmp/tianji-test',
  agentsDir: '/tmp/tianji-test/agents',
  logsDir: '/tmp/tianji-test/logs',
  configFilePath: '/tmp/tianji-test/tianji.json',
  cliLogFilePath: '/tmp/tianji-test/logs/tianji.log',
  daemonPortPath: '/tmp/tianji-test/daemon.port',
  daemonPidPath: '/tmp/tianji-test/daemon.pid',
}

const listenMock = vi.fn(async () => undefined)
const shutdownMock = vi.fn(async () => undefined)
const stopConnectionMock = vi.fn()
const startConnectionMock = vi.fn(async () => undefined)
const connectionStateCallbackRef: {
  current?: (event: { status: string; error?: string }) => void
} = {}
const createControlPlaneRuntimeMock = vi.fn(() => ({
  connection: {
    start: startConnectionMock,
    stop: stopConnectionMock,
  },
}))
const loadUserConfigContextMock = vi.fn<() => Promise<LoadUserConfigContextResult>>(async () => ({
  paths,
  config: {
    controlPlane: {
      baseUrl: 'http://127.0.0.1:3000',
      enrollmentToken: 'token',
      nodeId: 'node-1',
      version: 'v1',
    },
  },
  agent: {
    agentName: 'default',
    modelRef: 'openai/gpt-4.1',
    provider: 'openai',
    modelName: 'gpt-4.1',
    providerConfig: undefined,
    soulPath: '/tmp/tianji-test/agents/default/SOUL.md',
    soul: '# Test Agent',
    workspace: undefined,
  },
  resolvedEnvVars: [],
  snapshotStore: {},
}))
const logInfoMock = vi.fn(async () => undefined)
const logErrorMock = vi.fn(async () => undefined)
const logDebugMock = vi.fn(async () => undefined)
const observerLoggerMock = {
  trace: vi.fn(async () => undefined),
  debug: vi.fn(async () => undefined),
  info: vi.fn(async () => undefined),
  warn: vi.fn(async () => undefined),
  error: vi.fn(async () => undefined),
  fatal: vi.fn(async () => undefined),
  log: vi.fn(async () => undefined),
  child: vi.fn(() => observerLoggerMock),
}

function createMockAgentSession(sessionId = 'session-1'): AgentSession {
  return {
    sessionId,
    abort: vi.fn(),
    close: vi.fn(),
    queryWithGraph: () =>
      (async function* () {
        yield {
          type: 'GraphRunStarted',
          runId: 'run_graph_test',
          graphId: 'test',
          graphVersion: 1,
          mermaidDiagram: '',
          timestamp: 0,
        }
      })(),
  }
}

const createAgentSessionMock = vi.fn(() => createMockAgentSession())
const openAgentSessionMock = vi.fn(() => createMockAgentSession())
const buildDefaultGraphMock = vi.fn(async () => ({
  graph: {
    id: 'test',
    name: 'test',
    version: 1,
    source: 'static',
    locked: false,
    state: {},
    nodes: [],
    edges: [],
  },
  executorFactory: vi.fn(),
}))
const createUnifiedRuntimeEntryMock = vi.fn((options: object) => options)

async function collectEvents(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const items: unknown[] = []
  for await (const event of events) {
    items.push(event)
  }
  return items
}

async function waitFor(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  assertion()
}

vi.mock('../config.js', () => ({
  loadUserConfigContext: loadUserConfigContextMock,
}))

vi.mock('../i18n/index.js', () => ({
  createI18n: vi.fn(() => ({
    t: vi.fn(() => 'daemon listening'),
  })),
  detectLocale: vi.fn(() => 'en'),
}))

vi.mock('../logger.js', () => ({
  getCliLogger: vi.fn(() => ({
    logDebug: logDebugMock,
    logInfo: logInfoMock,
    logWarn: vi.fn(async () => undefined),
    logError: logErrorMock,
    appendCliLog: vi.fn(async () => undefined),
    observerLogger: observerLoggerMock,
  })),
  logDebug: logDebugMock,
  logInfo: logInfoMock,
  logError: logErrorMock,
}))

vi.mock('../node-runtime/controlplane-config.js', () => ({
  readStoredControlPlaneConfig: vi.fn(
    (config: { controlPlane?: object }) => config.controlPlane ?? null
  ),
  deriveControlPlaneAgentList: vi.fn(() => []),
}))

vi.mock('../node-runtime/controlplane-runtime.js', () => ({
  createControlPlaneRuntime: vi.fn((config: object) => {
    const maybeCallback = (
      config as { onConnectionStateChange?: (event: { status: string; error?: string }) => void }
    ).onConnectionStateChange
    connectionStateCallbackRef.current = maybeCallback
    return createControlPlaneRuntimeMock()
  }),
}))

vi.mock('@tianji/agent', () => ({
  DEFAULT_CONTROL_PLANE_STATUS: {
    enabled: false,
    status: 'disabled',
    baseUrl: null,
    lastSuccessAt: null,
    lastError: null,
  },
  createAgentSession: createAgentSessionMock,
  openAgentSession: openAgentSessionMock,
  buildDefaultGraph: buildDefaultGraphMock,
  createUnifiedRuntimeEntry: createUnifiedRuntimeEntryMock,
  loadDefaultOrchestrationGraph: vi.fn(async () => ({
    id: 'test',
    name: 'test',
    version: 1,
    source: 'static',
    locked: false,
    state: {},
    nodes: [],
    edges: [],
  })),
  createDeepagentsExecutorFactory: vi.fn(() => vi.fn()),
  DaemonServer: vi.fn().mockImplementation(() => ({
    port: 4321,
    listen: listenMock,
    shutdown: shutdownMock,
    deleteStateFiles: vi.fn(async () => undefined),
  })),
}))

describe('runDaemonEntry', () => {
  /** 每个测试持有的 handle，afterEach 通过 dispose() 摘除 process 监听器 */
  let handle: DaemonHandle | undefined

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    connectionStateCallbackRef.current = undefined
    handle = undefined
  })

  afterEach(() => {
    handle?.dispose()
    handle = undefined
  })

  it('publishes disabled controlplane status when no config exists', async () => {
    loadUserConfigContextMock.mockResolvedValueOnce({
      paths,
      config: {} as TianjiConfig,
      agent: {
        agentName: 'default',
        modelRef: 'openai/gpt-4.1',
        provider: 'openai',
        modelName: 'gpt-4.1',
        providerConfig: undefined,
        soulPath: '/tmp/tianji-test/agents/default/SOUL.md',
        soul: '# Test Agent',
        workspace: undefined,
      },
      resolvedEnvVars: [],
      snapshotStore: {},
    })
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const { runDaemonEntry } = await import('../daemon-entry.js')
    handle = await runDaemonEntry()

    const daemonServerCall = vi.mocked((await import('@tianji/agent')).DaemonServer).mock
      .calls[0]?.[0]
    const getControlPlaneStatus = (
      daemonServerCall as {
        getControlPlaneStatus?: () => {
          status: string
          enabled: boolean
          baseUrl: string | null
          lastError: string | null
        }
      }
    ).getControlPlaneStatus

    expect(getControlPlaneStatus).toBeTypeOf('function')
    expect(getControlPlaneStatus?.()).toEqual({
      enabled: false,
      status: 'disabled',
      baseUrl: null,
      lastSuccessAt: null,
      lastError: null,
    })

    stdoutSpy.mockRestore()
  })

  it('updates controlplane status to connected then degraded from runtime callbacks', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const { runDaemonEntry } = await import('../daemon-entry.js')
    const controlPlaneRuntimeModule = await import('../node-runtime/controlplane-runtime.js')
    handle = await runDaemonEntry()

    const runtimeConfig = vi
      .mocked(controlPlaneRuntimeModule.createControlPlaneRuntime)
      .mock.calls.at(0)
      ?.at(0) as Record<string, unknown> | undefined

    expect(runtimeConfig).toEqual(
      expect.objectContaining({
        nativeAgentContext: expect.objectContaining({ paths, config: expect.any(Object) }),
        defaultGraph: expect.objectContaining({ id: 'test', name: 'test' }),
        executorFactory: expect.any(Function),
      })
    )

    const daemonServerCall = vi.mocked((await import('@tianji/agent')).DaemonServer).mock
      .calls[0]?.[0]
    const getControlPlaneStatus = (daemonServerCall as { getControlPlaneStatus?: () => unknown })
      .getControlPlaneStatus

    expect(getControlPlaneStatus).toBeTypeOf('function')
    if (getControlPlaneStatus?.().status === 'disabled') {
      connectionStateCallbackRef.current?.({ status: 'connected' })
    }
    expect(getControlPlaneStatus?.()).toMatchObject({
      enabled: true,
      status: 'connected',
      baseUrl: 'http://127.0.0.1:3000',
      lastError: null,
    })

    connectionStateCallbackRef.current?.({ status: 'heartbeat_failed', error: 'fetch failed' })

    expect(getControlPlaneStatus?.()).toMatchObject({
      enabled: true,
      status: 'degraded',
      baseUrl: 'http://127.0.0.1:3000',
      lastError: 'fetch failed',
    })

    stdoutSpy.mockRestore()
  })

  it('passes native runtime dependencies into controlplane runtime', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const { runDaemonEntry } = await import('../daemon-entry.js')
    const controlPlaneRuntimeModule = await import('../node-runtime/controlplane-runtime.js')
    handle = await runDaemonEntry()

    const runtimeConfig = vi
      .mocked(controlPlaneRuntimeModule.createControlPlaneRuntime)
      .mock.calls.at(0)
      ?.at(0) as Record<string, unknown> | undefined

    expect(runtimeConfig).toBeDefined()
    expect(runtimeConfig?.nativeAgentContext).toEqual(
      expect.objectContaining({ paths, config: expect.any(Object) })
    )
    expect(runtimeConfig?.defaultGraph).toEqual(
      expect.objectContaining({ id: 'test', name: 'test', nodes: [], edges: [] })
    )
    expect(runtimeConfig?.executorFactory).toBeTypeOf('function')

    stdoutSpy.mockRestore()
  })

  it('creates agent session inside correlation context so startup emitEvent does not crash', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const startupSessionFactory = async (
      _context: LoadedAgentContext,
      options?: AgentRuntimeOptions
    ): Promise<AgentSession> => {
      await options?.emitEvent?.({
        type: 'SessionCreated',
        sessionId: 'session-startup' as never,
        timestamp: 0,
      })
      return createMockAgentSession('session-startup')
    }

    vi.mocked(createAgentSessionMock).mockImplementationOnce(startupSessionFactory as never)

    const { runDaemonEntry } = await import('../daemon-entry.js')

    handle = await runDaemonEntry()
    expect(handle).toHaveProperty('dispose')

    stdoutSpy.mockRestore()
  })

  it('returns runId and cancels the active daemon session by runId', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const abortSpy = vi.fn()

    vi.mocked(createAgentSessionMock).mockImplementationOnce(
      (): AgentSession => ({
        ...createMockAgentSession('session-cancel-test'),
        abort: abortSpy,
      })
    )
    vi.mocked(openAgentSessionMock).mockImplementationOnce(
      (): AgentSession => ({
        ...createMockAgentSession('session-cancel-test'),
        abort: abortSpy,
        queryWithGraph: () =>
          (async function* () {
            yield {
              type: 'RunCancelled',
              runId: 'run_graph_test',
              sessionId: 'session-cancel-test',
              timestamp: 0,
            }
          })(),
      })
    )

    const { runDaemonEntry } = await import('../daemon-entry.js')
    handle = await runDaemonEntry()

    const runtimeOptions = createUnifiedRuntimeEntryMock.mock.calls.at(-1)?.[0] as {
      runtime: {
        runGraph: (input: {
          request: { source: 'controlplane'; input: string; sessionId: string }
          graph: object
          executors: object
        }) => Promise<{ runId?: string; events: AsyncIterable<unknown> }>
        cancelRun: (input: { source: 'controlplane'; runId: string }) => Promise<void>
      }
    }

    const runHandle = await runtimeOptions.runtime.runGraph({
      request: {
        source: 'controlplane',
        input: 'cancel me',
        sessionId: 'session-cancel-test' as never,
      },
      graph: { id: 'test' },
      executors: {},
    })

    expect(runHandle.runId).toBe('run_graph_test')

    await runtimeOptions.runtime.cancelRun({ source: 'controlplane', runId: 'run_graph_test' })
    expect(abortSpy).toHaveBeenCalledTimes(1)

    const events = await collectEvents(runHandle.events)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'RunCancelled', runId: 'run_graph_test' })

    stdoutSpy.mockRestore()
  })

  it('keeps streaming graph terminal events after extracting runId from the first event', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    vi.mocked(openAgentSessionMock).mockImplementationOnce(
      (): AgentSession => ({
        ...createMockAgentSession('session-graph-terminal-test'),
        queryWithGraph: () =>
          (async function* () {
            yield {
              type: 'GraphRunStarted',
              runId: 'run_graph_terminal',
              graphId: 'test',
              graphVersion: 1,
              mermaidDiagram: '',
              timestamp: 0,
            }
            yield {
              type: 'GraphRunCancelled',
              runId: 'run_graph_terminal',
              graphId: 'test',
              graphVersion: 1,
              reason: 'abort',
              timestamp: 1,
            }
          })(),
      })
    )

    const { runDaemonEntry } = await import('../daemon-entry.js')
    handle = await runDaemonEntry()
    const openCallCountBeforeRun = openAgentSessionMock.mock.calls.length

    const runtimeOptions = createUnifiedRuntimeEntryMock.mock.calls.at(-1)?.[0] as {
      runtime: {
        runGraph: (input: {
          request: { source: 'controlplane'; input: string; sessionId: string }
          graph: object
          executors: object
        }) => Promise<{ runId?: string; events: AsyncIterable<unknown> }>
      }
    }

    const runHandle = await runtimeOptions.runtime.runGraph({
      request: {
        source: 'controlplane',
        input: 'cancel me',
        sessionId: 'session-graph-terminal-test' as never,
      },
      graph: { id: 'test' },
      executors: {},
    })

    expect(runHandle.runId).toBe('run_graph_terminal')

    const events = await collectEvents(runHandle.events)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'GraphRunStarted', runId: 'run_graph_terminal' })
    expect(events[1]).toMatchObject({ type: 'GraphRunCancelled', runId: 'run_graph_terminal' })

    stdoutSpy.mockRestore()
  })

  it('creates a session when daemon receives a fresh session id', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    vi.mocked(createAgentSessionMock).mockImplementationOnce(
      (): AgentSession => ({
        ...createMockAgentSession('session_fresh'),
        queryWithGraph: () =>
          (async function* () {
            yield {
              type: 'GraphRunStarted',
              runId: 'run_graph_fresh',
              graphId: 'test',
              graphVersion: 1,
              mermaidDiagram: '',
              timestamp: 0,
            }
            yield {
              type: 'GraphRunCompleted',
              runId: 'run_graph_fresh',
              graphId: 'test',
              graphVersion: 1,
              timestamp: 1,
            }
          })(),
      })
    )

    const { runDaemonEntry } = await import('../daemon-entry.js')
    handle = await runDaemonEntry()
    const openCallCountBeforeRun = openAgentSessionMock.mock.calls.length

    const runtimeOptions = createUnifiedRuntimeEntryMock.mock.calls.at(-1)?.[0] as {
      runtime: {
        runGraph: (input: {
          request: { source: 'controlplane'; input: string; sessionId: string }
          graph: object
          executors: object
        }) => Promise<{ runId?: string; events: AsyncIterable<unknown>; sessionId: string }>
      }
    }

    const runHandle = await runtimeOptions.runtime.runGraph({
      request: {
        source: 'controlplane',
        input: 'fresh session',
        sessionId: 'session_fresh' as never,
      },
      graph: { id: 'test' },
      executors: {},
    })

    expect(createAgentSessionMock).toHaveBeenCalledOnce()
    expect(openAgentSessionMock.mock.calls.length).toBe(openCallCountBeforeRun + 1)
    expect(runHandle.sessionId).toBe('session-1')

    stdoutSpy.mockRestore()
  })

  it('opens an existing session when daemon receives a non-fresh session id', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    vi.mocked(openAgentSessionMock).mockImplementationOnce(
      (): AgentSession => ({
        ...createMockAgentSession('existing-session'),
        queryWithGraph: () =>
          (async function* () {
            yield {
              type: 'GraphRunStarted',
              runId: 'run_graph_existing',
              graphId: 'test',
              graphVersion: 1,
              mermaidDiagram: '',
              timestamp: 0,
            }
          })(),
      })
    )

    const { runDaemonEntry } = await import('../daemon-entry.js')
    handle = await runDaemonEntry()

    const runtimeOptions = createUnifiedRuntimeEntryMock.mock.calls.at(-1)?.[0] as {
      runtime: {
        runGraph: (input: {
          request: { source: 'controlplane'; input: string; sessionId: string }
          graph: object
          executors: object
        }) => Promise<{ sessionId: string }>
      }
    }

    await runtimeOptions.runtime.runGraph({
      request: {
        source: 'controlplane',
        input: 'existing session',
        sessionId: 'existing-session' as never,
      },
      graph: { id: 'test' },
      executors: {},
    })

    expect(openAgentSessionMock).toHaveBeenCalledOnce()

    stdoutSpy.mockRestore()
  })

  it('logs info when daemon receives SIGTERM and exits cleanly', async () => {
    const processOnSpy = vi.spyOn(process, 'on')
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const { runDaemonEntry } = await import('../daemon-entry.js')
    handle = await runDaemonEntry()

    const sigtermHandler = processOnSpy.mock.calls.find(([event]) => event === 'SIGTERM')?.[1]
    expect(sigtermHandler).toBeTypeOf('function')

    sigtermHandler?.()

    await waitFor(() => {
      expect(shutdownMock).toHaveBeenCalled()
    })

    expect(logInfoMock).toHaveBeenCalledWith(paths, ['daemon'], 'Daemon shutdown signal received', {
      signal: 'SIGTERM',
    })
    expect(logInfoMock).toHaveBeenCalledWith(paths, ['daemon'], 'Daemon exiting', {
      reason: 'signal',
      signal: 'SIGTERM',
    })
    expect(stopConnectionMock).toHaveBeenCalled()
    expect(processExitSpy).toHaveBeenCalledWith(0)

    stdoutSpy.mockRestore()
  })

  it('logs error when daemon catches uncaughtException and exits non-zero', async () => {
    const processOnSpy = vi.spyOn(process, 'on')
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const { runDaemonEntry } = await import('../daemon-entry.js')
    handle = await runDaemonEntry()

    const uncaughtExceptionHandler = processOnSpy.mock.calls.find(
      ([event]) => event === 'uncaughtException'
    )?.[1]
    expect(uncaughtExceptionHandler).toBeTypeOf('function')

    const error = new Error('boom')
    uncaughtExceptionHandler?.(error)

    await waitFor(() => {
      expect(shutdownMock).toHaveBeenCalledOnce()
    })

    expect(observerLoggerMock.fatal).toHaveBeenCalledWith(
      ['daemon'],
      'Daemon crashed with uncaught exception',
      expect.objectContaining({ name: 'Error', message: 'boom' })
    )
    expect(logInfoMock).toHaveBeenCalledWith(paths, ['daemon'], 'Daemon exiting', {
      reason: 'uncaughtException',
      signal: undefined,
    })
    expect(processExitSpy).toHaveBeenCalledWith(1)

    stdoutSpy.mockRestore()
  })

  it('logs error when daemon catches unhandledRejection and keeps running', async () => {
    const processOnSpy = vi.spyOn(process, 'on')
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const { runDaemonEntry } = await import('../daemon-entry.js')
    handle = await runDaemonEntry()

    const unhandledRejectionHandler = processOnSpy.mock.calls.find(
      ([event]) => event === 'unhandledRejection'
    )?.[1]
    expect(unhandledRejectionHandler).toBeTypeOf('function')

    unhandledRejectionHandler?.('rejected')

    await waitFor(() => {
      expect(observerLoggerMock.error).toHaveBeenCalledWith(
        ['daemon'],
        'Daemon caught unhandled rejection',
        expect.objectContaining({ message: 'rejected' })
      )
    })

    expect(shutdownMock).not.toHaveBeenCalled()
    expect(logInfoMock).not.toHaveBeenCalledWith(paths, ['daemon'], 'Daemon exiting', {
      reason: 'unhandledRejection',
      signal: undefined,
    })
    expect(processExitSpy).not.toHaveBeenCalled()

    stdoutSpy.mockRestore()
  })

  it('removes process listeners after shutdown completes', async () => {
    // 验证 shutdown 路径（.finally(unregisterProcessHandlers)）自己负责回收监听器。
    // 该用例不调用 dispose，让 .finally 自己跑，以确保 shutdown 路径的回收是自给自足的。
    const processOnSpy = vi.spyOn(process, 'on')
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const baselineSIGTERM = process.listenerCount('SIGTERM')
    const baselineSIGINT = process.listenerCount('SIGINT')
    const baselineUncaughtException = process.listenerCount('uncaughtException')
    const baselineUnhandledRejection = process.listenerCount('unhandledRejection')

    const { runDaemonEntry } = await import('../daemon-entry.js')
    // 不赋给外层 handle：shutdown 完成后 .finally 已回收监听器，afterEach 的 dispose 不需要介入
    const localHandle = await runDaemonEntry()

    expect(process.listenerCount('SIGTERM')).toBe(baselineSIGTERM + 1)
    expect(process.listenerCount('SIGINT')).toBe(baselineSIGINT + 1)
    expect(process.listenerCount('uncaughtException')).toBe(baselineUncaughtException + 1)
    expect(process.listenerCount('unhandledRejection')).toBe(baselineUnhandledRejection + 1)

    const sigtermHandler = processOnSpy.mock.calls.find(([event]) => event === 'SIGTERM')?.[1]
    sigtermHandler?.()

    await waitFor(() => {
      expect(shutdownMock).toHaveBeenCalled()
    })

    await waitFor(() => {
      expect(process.listenerCount('SIGTERM')).toBe(baselineSIGTERM)
      expect(process.listenerCount('SIGINT')).toBe(baselineSIGINT)
      expect(process.listenerCount('uncaughtException')).toBe(baselineUncaughtException)
      expect(process.listenerCount('unhandledRejection')).toBe(baselineUnhandledRejection)
    })

    // shutdown 已通过 .finally 摘除监听器；再调用 localHandle.dispose() 应是 no-op（process.off 幂等）
    expect(() => localHandle.dispose()).not.toThrow()
    expect(process.listenerCount('SIGTERM')).toBe(baselineSIGTERM)
    expect(process.listenerCount('SIGINT')).toBe(baselineSIGINT)
    expect(process.listenerCount('uncaughtException')).toBe(baselineUncaughtException)
    expect(process.listenerCount('unhandledRejection')).toBe(baselineUnhandledRejection)

    stdoutSpy.mockRestore()
  })

  it('dispose() removes process listeners without shutdown', async () => {
    // 验证 production dispose API：无需触发 shutdown 即可精确摘除监听器
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const baselineSIGTERM = process.listenerCount('SIGTERM')
    const baselineSIGINT = process.listenerCount('SIGINT')
    const baselineUncaughtException = process.listenerCount('uncaughtException')
    const baselineUnhandledRejection = process.listenerCount('unhandledRejection')

    const { runDaemonEntry } = await import('../daemon-entry.js')
    handle = await runDaemonEntry()

    expect(process.listenerCount('SIGTERM')).toBe(baselineSIGTERM + 1)
    expect(process.listenerCount('SIGINT')).toBe(baselineSIGINT + 1)
    expect(process.listenerCount('uncaughtException')).toBe(baselineUncaughtException + 1)
    expect(process.listenerCount('unhandledRejection')).toBe(baselineUnhandledRejection + 1)

    handle.dispose()

    expect(process.listenerCount('SIGTERM')).toBe(baselineSIGTERM)
    expect(process.listenerCount('SIGINT')).toBe(baselineSIGINT)
    expect(process.listenerCount('uncaughtException')).toBe(baselineUncaughtException)
    expect(process.listenerCount('unhandledRejection')).toBe(baselineUnhandledRejection)
  })
})
