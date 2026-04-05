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
})
