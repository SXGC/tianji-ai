import { readFile, writeFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'
import { parseCliArgs, runCli } from '../main.js'
import { captureStdout, createTempCliPaths } from './helpers/cli-test-utils.js'

describe('parseCliArgs daemon commands', () => {
  it('parses daemon start command', () => {
    expect(parseCliArgs(['daemon', 'start'])).toEqual({
      kind: 'daemon',
      subcommand: 'start',
      foreground: false,
    })
    expect(
      parseCliArgs([
        'daemon',
        'start',
        '--register',
        'http://127.0.0.1:3000/register?enrollment-token=test-token',
      ])
    ).toEqual({
      kind: 'daemon',
      subcommand: 'start',
      foreground: false,
      registerUrl: 'http://127.0.0.1:3000/register?enrollment-token=test-token',
    })
    expect(parseCliArgs(['daemon', 'start', '--fg'])).toEqual({
      kind: 'daemon',
      subcommand: 'start',
      foreground: true,
    })
  })

  it('parses daemon status, stop, and restart commands', () => {
    expect(parseCliArgs(['daemon', 'status'])).toEqual({
      kind: 'daemon',
      subcommand: 'status',
      foreground: false,
    })
    expect(parseCliArgs(['daemon', 'stop'])).toEqual({
      kind: 'daemon',
      subcommand: 'stop',
      foreground: false,
    })
    expect(parseCliArgs(['daemon', 'restart'])).toEqual({
      kind: 'daemon',
      subcommand: 'restart',
      foreground: false,
    })
    expect(parseCliArgs(['daemon', 'restart', '--fg'])).toEqual({
      kind: 'daemon',
      subcommand: 'restart',
      foreground: true,
    })
  })

  it('rejects daemon without subcommand', () => {
    expect(() => parseCliArgs(['daemon'])).toThrow(/Missing subcommand for "daemon"/)
  })

  it('rejects unknown daemon subcommands', () => {
    expect(() => parseCliArgs(['daemon', 'bad'])).toThrow(/Unknown subcommand "bad" for "daemon"/)
  })

  it('rejects unknown flags on daemon start', () => {
    expect(() => parseCliArgs(['daemon', 'start', '--bad'])).toThrow(/Unknown option "--bad"/)
  })

  it('rejects extra args on status and stop subcommands', () => {
    expect(() => parseCliArgs(['daemon', 'status', '--fg'])).toThrow(/Unknown option "--fg"/)
    expect(() => parseCliArgs(['daemon', 'stop', '--fg'])).toThrow(/Unknown option "--fg"/)
    expect(() =>
      parseCliArgs([
        'daemon',
        'restart',
        '--register',
        'http://127.0.0.1:3000/register?enrollment-token=test-token',
      ])
    ).toThrow(/Unknown option "--register"/)
  })

  it('rejects old top-level status and stop commands', () => {
    expect(() => parseCliArgs(['status'])).toThrow(/Unknown command/)
    expect(() => parseCliArgs(['stop'])).toThrow(/Unknown command/)
  })
})

describe('createTempCliPaths daemon paths', () => {
  it('creates daemon pid and port paths for daemon CLI tests', async () => {
    const { paths, cleanup } = await createTempCliPaths()

    try {
      expect(paths.daemonPortPath).toContain('daemon.port')
      expect(paths.daemonPidPath).toContain('daemon.pid')
    } finally {
      await cleanup()
    }
  })
})

describe('runCli daemon commands', () => {
  it('shows daemon command help through help flag', async () => {
    const output = await captureStdout(async () => {
      const exitCode = await runCli(['daemon', '--help'])
      expect(exitCode).toBe(0)
    })

    expect(output).toContain('tianji daemon <subcommand>')
    expect(output).toContain('start')
    expect(output).toContain('--fg')
  })

  it('returns translated usage error without embedding full help text', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {})

    const exitCode = await runCli(['daemon'])

    expect(exitCode).toBe(2)
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/Missing subcommand/))
    expect(stderr).not.toHaveBeenCalledWith(expect.stringMatching(/tianji run <prompt>/))
  })

  it('returns non-zero when daemon status cannot find daemon', async () => {
    const exitCode = await runCli(['daemon', 'status'], {
      getUserConfigPaths: () => ({
        configDir: '/tmp/test-daemon-status',
        agentsDir: '/tmp/test-daemon-status/agents',
        logsDir: '/tmp/test-daemon-status/logs',
        configFilePath: '/tmp/test-daemon-status/tianji.json',
        cliLogFilePath: '/tmp/test-daemon-status/logs/tianji.log',
        daemonPortPath: '/tmp/test-daemon-status/daemon.port',
        daemonPidPath: '/tmp/test-daemon-status/daemon.pid',
      }),
    })
    expect(exitCode).toBe(1)
  })

  it('prints controlplane status details in daemon status output', async () => {
    const { paths, cleanup } = await createTempCliPaths()

    try {
      await writeFile(paths.daemonPortPath, '32123', 'utf8')

      const ping = {
        pid: 4321,
        sessionId: 'session-1',
        uptime: 684,
        controlPlane: {
          enabled: true,
          status: 'degraded',
          baseUrl: 'http://127.0.0.1:3000',
          lastSuccessAt: 123,
          lastError: 'fetch failed',
        },
      }

      vi.resetModules()
      vi.doMock('@tianji/agent', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@tianji/agent')>()
        return {
          ...actual,
          DaemonClient: vi.fn().mockImplementation(() => ({
            ping: vi.fn(async () => ping),
            close: vi.fn(),
          })),
        }
      })

      const { runCli: isolatedRunCli } = await import('../main.js')
      const output = await captureStdout(async () => {
        const exitCode = await isolatedRunCli(['daemon', 'status'], {
          getUserConfigPaths: () => paths,
        })
        expect(exitCode).toBe(0)
      })

      expect(output).toContain('Daemon running')
      expect(output).toContain('controlplane=degraded')
      expect(output).toContain('controlplaneUrl=http://127.0.0.1:3000')
      expect(output).toContain('controlplaneError=fetch failed')
    } finally {
      vi.doUnmock('@tianji/agent')
      await cleanup()
    }
  })

  it('runs daemon start --fg through injected daemon entry', async () => {
    const runDaemonEntry = vi.fn(async () => undefined)
    const { paths, cleanup } = await createTempCliPaths()

    try {
      const exitCode = await runCli(['daemon', 'start', '--fg'], {
        getUserConfigPaths: () => paths,
        runDaemonEntry,
        loadConfig: async () => ({
          controlPlane: {
            baseUrl: 'http://localhost:3000',
            enrollmentToken: 'tok',
            nodeId: 'n1',
          },
        }),
      })

      expect(exitCode).toBe(0)
      expect(runDaemonEntry).toHaveBeenCalledOnce()
    } finally {
      await cleanup()
    }
  })

  it('runs daemon restart --fg through injected daemon entry', async () => {
    const runDaemonEntry = vi.fn(async () => undefined)
    const { paths, cleanup } = await createTempCliPaths()

    try {
      const exitCode = await runCli(['daemon', 'restart', '--fg'], {
        getUserConfigPaths: () => paths,
        runDaemonEntry,
      })

      expect(exitCode).toBe(0)
      expect(runDaemonEntry).toHaveBeenCalledOnce()
    } finally {
      await cleanup()
    }
  })

  it('daemon restart --fg fails when recorded pid does not exit after shutdown', async () => {
    const runDaemonEntry = vi.fn(async () => undefined)
    const { paths, cleanup } = await createTempCliPaths()

    try {
      await writeFile(paths.daemonPortPath, '32123', 'utf8')
      await writeFile(paths.daemonPidPath, '4321', 'utf8')

      const shutdown = vi.fn(async () => undefined)
      const close = vi.fn()
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
        pid: number,
        signal?: NodeJS.Signals | number
      ) => {
        if (pid === 4321 && signal === 0) {
          return true
        }

        return true
      }) as typeof process.kill)

      vi.resetModules()
      vi.doMock('@tianji/agent', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@tianji/agent')>()
        return {
          ...actual,
          DaemonClient: vi.fn().mockImplementation(() => ({
            ping: vi.fn(async () => ({
              pid: 4321,
              sessionId: 'session-1',
              uptime: 10,
              controlPlane: {
                enabled: false,
                status: 'disabled',
                baseUrl: null,
                lastSuccessAt: null,
                lastError: null,
              },
            })),
            shutdown,
            close,
          })),
        }
      })

      const originalDateNow = Date.now
      let now = 0
      vi.spyOn(Date, 'now').mockImplementation(() => {
        now += 1000
        return now
      })

      const { runCli: isolatedRunCli } = await import('../main.js')
      const exitCode = await isolatedRunCli(['daemon', 'restart', '--fg'], {
        getUserConfigPaths: () => paths,
        runDaemonEntry,
      })

      expect(exitCode).toBe(1)
      expect(shutdown).toHaveBeenCalledOnce()
      expect(runDaemonEntry).not.toHaveBeenCalled()
      Date.now = originalDateNow
      killSpy.mockRestore()
    } finally {
      vi.doUnmock('@tianji/agent')
      await cleanup()
    }
  })

  it('daemon restart --fg fails when pid file disappears but process stays alive', async () => {
    const runDaemonEntry = vi.fn(async () => undefined)
    const { paths, cleanup } = await createTempCliPaths()

    try {
      await writeFile(paths.daemonPortPath, '32123', 'utf8')
      await writeFile(paths.daemonPidPath, '4321', 'utf8')

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
        pid: number,
        signal?: NodeJS.Signals | number
      ) => {
        if (pid === 4321 && signal === 0) {
          return true
        }

        return true
      }) as typeof process.kill)

      vi.resetModules()
      vi.doMock('@tianji/agent', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@tianji/agent')>()
        return {
          ...actual,
          DaemonClient: vi.fn().mockImplementation(() => ({
            ping: vi.fn(async () => ({
              pid: 4321,
              sessionId: 'session-1',
              uptime: 10,
              controlPlane: {
                enabled: false,
                status: 'disabled',
                baseUrl: null,
                lastSuccessAt: null,
                lastError: null,
              },
            })),
            shutdown: vi.fn(async () => {
              await import('node:fs/promises').then((fs) =>
                fs.unlink(paths.daemonPidPath).catch(() => {})
              )
            }),
            close: vi.fn(),
          })),
        }
      })

      const originalDateNow = Date.now
      let now = 0
      vi.spyOn(Date, 'now').mockImplementation(() => {
        now += 1000
        return now
      })

      const { runCli: isolatedRunCli } = await import('../main.js')
      const exitCode = await isolatedRunCli(['daemon', 'restart', '--fg'], {
        getUserConfigPaths: () => paths,
        runDaemonEntry,
      })

      expect(exitCode).toBe(1)
      expect(runDaemonEntry).not.toHaveBeenCalled()
      Date.now = originalDateNow
      killSpy.mockRestore()
    } finally {
      vi.doUnmock('@tianji/agent')
      await cleanup()
    }
  })

  it('daemon restart --fg starts replacement after recorded pid exits', async () => {
    const runDaemonEntry = vi.fn(async () => undefined)
    const { paths, cleanup } = await createTempCliPaths()

    try {
      await writeFile(paths.daemonPortPath, '32123', 'utf8')
      await writeFile(paths.daemonPidPath, '4321', 'utf8')

      let processAlive = true
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
        pid: number,
        signal?: NodeJS.Signals | number
      ) => {
        if (pid === 4321 && signal === 0 && processAlive) {
          throw new Error('process still running')
        }

        return true
      }) as typeof process.kill)

      vi.resetModules()
      vi.doMock('@tianji/agent', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@tianji/agent')>()
        return {
          ...actual,
          DaemonClient: vi.fn().mockImplementation(() => ({
            ping: vi.fn(async () => ({
              pid: 4321,
              sessionId: 'session-1',
              uptime: 10,
              controlPlane: {
                enabled: false,
                status: 'disabled',
                baseUrl: null,
                lastSuccessAt: null,
                lastError: null,
              },
            })),
            shutdown: vi.fn(async () => {
              setTimeout(() => {
                processAlive = false
              }, 50)
            }),
            close: vi.fn(),
          })),
        }
      })

      const { runCli: isolatedRunCli } = await import('../main.js')
      const exitCode = await isolatedRunCli(['daemon', 'restart', '--fg'], {
        getUserConfigPaths: () => paths,
        runDaemonEntry,
      })

      expect(exitCode).toBe(0)
      expect(runDaemonEntry).toHaveBeenCalledOnce()
      killSpy.mockRestore()
    } finally {
      vi.doUnmock('@tianji/agent')
      await cleanup()
    }
  })

  it('daemon start --fg refuses to start when pid is still alive behind stale port state', async () => {
    const runDaemonEntry = vi.fn(async () => undefined)
    const { paths, cleanup } = await createTempCliPaths()

    try {
      await writeFile(paths.daemonPortPath, '32123', 'utf8')
      await writeFile(paths.daemonPidPath, '4321', 'utf8')

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
        pid: number,
        signal?: NodeJS.Signals | number
      ) => {
        if (pid === 4321 && signal === 0) {
          return true
        }

        return true
      }) as typeof process.kill)

      vi.resetModules()
      vi.doMock('@tianji/agent', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@tianji/agent')>()
        return {
          ...actual,
          DaemonClient: vi.fn().mockImplementation(() => ({
            ping: vi.fn(async () => {
              throw new Error('connect ECONNREFUSED')
            }),
            close: vi.fn(),
          })),
        }
      })

      const { runCli: isolatedRunCli } = await import('../main.js')
      const exitCode = await isolatedRunCli(['daemon', 'start', '--fg'], {
        getUserConfigPaths: () => paths,
        runDaemonEntry,
        loadConfig: async () => ({
          controlPlane: {
            baseUrl: 'http://localhost:3000',
            enrollmentToken: 'tok',
            nodeId: 'n1',
          },
        }),
      })

      expect(exitCode).toBe(1)
      expect(runDaemonEntry).not.toHaveBeenCalled()
      killSpy.mockRestore()
    } finally {
      vi.doUnmock('@tianji/agent')
      await cleanup()
    }
  })

  it('daemon start --fg with no stored config and no --register returns exitCode 1', async () => {
    expect.assertions(2)
    const runDaemonEntry = vi.fn(async () => undefined)
    const { paths, cleanup } = await createTempCliPaths()

    try {
      const exitCode = await runCli(['daemon', 'start', '--fg'], {
        getUserConfigPaths: () => paths,
        runDaemonEntry,
        loadConfig: async () => ({}),
      })

      expect(exitCode).toBe(1)
      expect(runDaemonEntry).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })

  it('daemon start --fg --register with conflicting stored config and declined overwrite returns 0', async () => {
    expect.assertions(2)
    const runDaemonEntry = vi.fn(async () => undefined)
    const { paths, cleanup } = await createTempCliPaths()

    try {
      const exitCode = await runCli(
        [
          'daemon',
          'start',
          '--fg',
          '--register',
          'http://127.0.0.1:3000/register?enrollment-token=new-token',
        ],
        {
          getUserConfigPaths: () => paths,
          runDaemonEntry,
          loadConfig: async () => ({
            controlPlane: {
              baseUrl: 'http://127.0.0.1:3000',
              enrollmentToken: 'old-token',
              nodeId: 'n1',
            },
          }),
          confirmOverwrite: async () => false,
          saveConfig: vi.fn(async () => undefined),
        }
      )

      expect(exitCode).toBe(0)
      expect(runDaemonEntry).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })

  it('daemon start --fg --register with no stored config saves config and starts daemon', async () => {
    expect.assertions(3)
    const runDaemonEntry = vi.fn(async () => undefined)
    const saveConfig = vi.fn(async () => undefined)
    const { paths, cleanup } = await createTempCliPaths()

    try {
      const exitCode = await runCli(
        [
          'daemon',
          'start',
          '--fg',
          '--register',
          'http://127.0.0.1:3000/register?enrollment-token=test-token',
        ],
        {
          getUserConfigPaths: () => paths,
          runDaemonEntry,
          loadConfig: async () => ({}),
          saveConfig,
        }
      )

      expect(exitCode).toBe(0)
      expect(saveConfig).toHaveBeenCalledOnce()
      expect(runDaemonEntry).toHaveBeenCalledOnce()
    } finally {
      await cleanup()
    }
  })

  it('daemon start --fg --register with same stored config skips confirmation and starts daemon', async () => {
    expect.assertions(2)
    const runDaemonEntry = vi.fn(async () => undefined)
    const confirmOverwrite = vi.fn(async () => false)
    const { paths, cleanup } = await createTempCliPaths()

    try {
      const exitCode = await runCli(
        [
          'daemon',
          'start',
          '--fg',
          '--register',
          'http://127.0.0.1:3000/register?enrollment-token=test-token',
        ],
        {
          getUserConfigPaths: () => paths,
          runDaemonEntry,
          loadConfig: async () => ({
            controlPlane: {
              baseUrl: 'http://127.0.0.1:3000',
              enrollmentToken: 'test-token',
              nodeId: 'n1',
            },
          }),
          confirmOverwrite,
        }
      )

      expect(exitCode).toBe(0)
      expect(confirmOverwrite).not.toHaveBeenCalled()
    } finally {
      await cleanup()
    }
  })

  it('daemon start --fg --register writes key steps as info logs', async () => {
    expect.assertions(6)
    const runDaemonEntry = vi.fn(async () => undefined)
    const saveConfig = vi.fn(async () => undefined)
    const { paths, cleanup } = await createTempCliPaths()

    try {
      const exitCode = await runCli(
        [
          'daemon',
          'start',
          '--fg',
          '--register',
          'http://127.0.0.1:3000/register?enrollment-token=test-token',
        ],
        {
          getUserConfigPaths: () => paths,
          runDaemonEntry,
          loadConfig: async () => ({}),
          saveConfig,
        }
      )

      expect(exitCode).toBe(0)
      expect(saveConfig).toHaveBeenCalledOnce()
      expect(runDaemonEntry).toHaveBeenCalledOnce()

      const logContent = await readFile(paths.cliLogFilePath, 'utf8')
      const entries = logContent
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { level: string; message: string })

      expect(
        entries.some(
          (entry) => entry.level === 'info' && entry.message === 'Loaded daemon configuration'
        )
      ).toBe(true)
      expect(
        entries.some(
          (entry) =>
            entry.level === 'info' && entry.message === 'Saved control plane registration config'
        )
      ).toBe(true)
      expect(
        entries.some(
          (entry) =>
            entry.level === 'info' && entry.message === 'Starting daemon in foreground mode'
        )
      ).toBe(true)
    } finally {
      await cleanup()
    }
  })

  it('reports daemon crash reason instead of timeout when background start dies early', async () => {
    const { paths, cleanup } = await createTempCliPaths()

    try {
      vi.resetModules()
      vi.doMock('@tianji/agent', async (importOriginal) => {
        const actual = await importOriginal<typeof import('@tianji/agent')>()

        return {
          ...actual,
          DaemonClient: vi.fn().mockImplementation(() => ({
            ping: vi.fn(async () => {
              throw new Error('daemon unavailable')
            }),
            close: vi.fn(),
          })),
        }
      })

      const processKillSpy = vi
        .spyOn(process, 'kill')
        .mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
          if (signal === 0 && pid === 4321) {
            throw new Error('process exited')
          }

          return true
        })

      const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const originalDateNow = Date.now
      let now = 0
      vi.spyOn(Date, 'now').mockImplementation(() => {
        now += 200
        return now
      })

      const readFileSpy = vi.fn(async (path: string) => {
        if (path === paths.daemonPortPath) {
          return '32123'
        }

        if (path === paths.daemonPidPath) {
          return '4321'
        }

        throw new Error(`unexpected path: ${path}`)
      })

      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs/promises')>()

        return {
          ...actual,
          readFile: readFileSpy,
        }
      })

      const { runCli: isolatedRunCli } = await import('../main.js')

      const exitCode = await isolatedRunCli(
        [
          'daemon',
          'start',
          '--register',
          'http://127.0.0.1:3000/register?enrollment-token=test-token',
        ],
        {
          getUserConfigPaths: () => paths,
          loadConfig: async () => ({}),
          saveConfig: vi.fn(async () => undefined),
        }
      )

      expect(exitCode).toBe(1)
      expect(stderrSpy).toHaveBeenCalledWith(
        'Daemon process exited before becoming ready (pid=4321)'
      )

      Date.now = originalDateNow
      processKillSpy.mockRestore()
      stderrSpy.mockRestore()
      vi.doUnmock('@tianji/agent')
      vi.doUnmock('node:fs/promises')
    } finally {
      await cleanup()
    }
  })
})
