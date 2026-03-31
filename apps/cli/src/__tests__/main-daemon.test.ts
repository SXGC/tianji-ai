import { describe, expect, it } from 'vitest'
import { parseCliArgs, runCli } from '../main.js'

describe('parseCliArgs daemon commands', () => {
  it('parses daemon command', () => {
    expect(parseCliArgs(['daemon'])).toEqual({ kind: 'daemon', foreground: false })
    expect(parseCliArgs(['daemon', '--fg'])).toEqual({ kind: 'daemon', foreground: true })
  })

  it('parses chat status and stop commands', () => {
    expect(parseCliArgs(['chat'])).toEqual({ kind: 'chat' })
    expect(parseCliArgs(['status'])).toEqual({ kind: 'status' })
    expect(parseCliArgs(['stop'])).toEqual({ kind: 'stop' })
  })

  it('rejects unknown daemon flags', () => {
    expect(() => parseCliArgs(['daemon', '--bad'])).toThrow(/daemon.*--fg/)
  })
})

describe('runCli daemon commands', () => {
  it('returns non-zero when status cannot find daemon', async () => {
    const exitCode = await runCli(['status'], {
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
})
