import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { UserConfigPaths } from '../config.js'

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
const createControlPlaneRuntimeMock = vi.fn(() => ({
  connection: {
    start: startConnectionMock,
    stop: stopConnectionMock,
  },
}))
const loadUserConfigContextMock = vi.fn(async () => ({
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
  createControlPlaneRuntime: createControlPlaneRuntimeMock,
}))

vi.mock('@tianji/agent', () => ({
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
      expect(shutdownMock).toHaveBeenCalledOnce()
    })

    expect(logInfoMock).toHaveBeenCalledWith(paths, ['daemon'], 'Daemon shutdown signal received', {
      signal: 'SIGTERM',
    })
    expect(logInfoMock).toHaveBeenCalledWith(paths, ['daemon'], 'Daemon exiting', {
      reason: 'signal',
      signal: 'SIGTERM',
    })
    expect(stopConnectionMock).toHaveBeenCalledOnce()

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
