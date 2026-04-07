import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TianjiConfig } from '@tianji/shared'

import type { UserConfigPaths } from '../config.js'

type LoadUserConfigContextResult = {
  paths: UserConfigPaths
  config: TianjiConfig
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
}))
const logInfoMock = vi.fn(async () => undefined)
const logErrorMock = vi.fn(async () => undefined)
const logDebugMock = vi.fn(async () => undefined)
const createAgentSessionMock = vi.fn(() => ({ sessionId: 'session-1' }))

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
  DaemonServer: vi.fn().mockImplementation(() => ({
    port: 4321,
    listen: listenMock,
    shutdown: shutdownMock,
  })),
}))

describe('runDaemonEntry', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    connectionStateCallbackRef.current = undefined
  })

  it('publishes disabled controlplane status when no config exists', async () => {
    loadUserConfigContextMock.mockResolvedValueOnce({
      paths,
      config: {} as TianjiConfig,
    })
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const { runDaemonEntry } = await import('../daemon-entry.js')
    await runDaemonEntry()

    const daemonServerCall = vi.mocked((await import('@tianji/agent')).DaemonServer).mock
      .calls[0]?.[0]
    const getControlPlaneStatus = (daemonServerCall as { getControlPlaneStatus?: () => unknown })
      .getControlPlaneStatus

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
    await runDaemonEntry()

    const runtimeConfig = createControlPlaneRuntimeMock.mock.calls.at(0)?.at(0) as
      | Record<string, unknown>
      | undefined

    expect(runtimeConfig).toEqual(
      expect.objectContaining({
        nativeAgentContext: expect.objectContaining({ paths, config: expect.any(Object) }),
      })
    )

    const daemonServerCall = vi.mocked((await import('@tianji/agent')).DaemonServer).mock
      .calls[0]?.[0]
    const getControlPlaneStatus = (daemonServerCall as { getControlPlaneStatus?: () => unknown })
      .getControlPlaneStatus

    expect(getControlPlaneStatus).toBeTypeOf('function')
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

  it('logs info when daemon receives SIGTERM and exits cleanly', async () => {
    const processOnSpy = vi.spyOn(process, 'on')
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const { runDaemonEntry } = await import('../daemon-entry.js')
    await runDaemonEntry()

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

    stdoutSpy.mockRestore()
  })

  it('logs error when daemon catches uncaughtException and exits non-zero', async () => {
    const processOnSpy = vi.spyOn(process, 'on')
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const { runDaemonEntry } = await import('../daemon-entry.js')
    await runDaemonEntry()

    const uncaughtExceptionHandler = processOnSpy.mock.calls.find(
      ([event]) => event === 'uncaughtException'
    )?.[1]
    expect(uncaughtExceptionHandler).toBeTypeOf('function')

    const error = new Error('boom')
    uncaughtExceptionHandler?.(error)

    await waitFor(() => {
      expect(shutdownMock).toHaveBeenCalledOnce()
    })

    expect(logErrorMock).toHaveBeenCalledWith(
      paths,
      ['daemon'],
      'Daemon crashed with uncaught exception',
      {
        error: 'boom',
      }
    )
    expect(logInfoMock).toHaveBeenCalledWith(paths, ['daemon'], 'Daemon exiting', {
      reason: 'uncaughtException',
      signal: undefined,
    })

    stdoutSpy.mockRestore()
  })

  it('logs error when daemon catches unhandledRejection and exits non-zero', async () => {
    const processOnSpy = vi.spyOn(process, 'on')
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const { runDaemonEntry } = await import('../daemon-entry.js')
    await runDaemonEntry()

    const unhandledRejectionHandler = processOnSpy.mock.calls.find(
      ([event]) => event === 'unhandledRejection'
    )?.[1]
    expect(unhandledRejectionHandler).toBeTypeOf('function')

    unhandledRejectionHandler?.('rejected')

    await waitFor(() => {
      expect(shutdownMock).toHaveBeenCalledOnce()
    })

    expect(logErrorMock).toHaveBeenCalledWith(
      paths,
      ['daemon'],
      'Daemon crashed with unhandled rejection',
      {
        error: 'rejected',
      }
    )
    expect(logInfoMock).toHaveBeenCalledWith(paths, ['daemon'], 'Daemon exiting', {
      reason: 'unhandledRejection',
      signal: undefined,
    })

    stdoutSpy.mockRestore()
  })
})
