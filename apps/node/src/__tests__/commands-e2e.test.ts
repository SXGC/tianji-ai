import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../main.js'
import {
  captureStdout,
  createDepsWithLocale,
  createDepsWithoutLocale,
} from './helpers/cli-test-utils.js'

async function runCommand(argv: readonly string[], deps = createDepsWithoutLocale()) {
  let exitCode = 0
  const stdout = await captureStdout(async () => {
    exitCode = await runCli(argv, deps)
  })

  return { exitCode, stdout }
}

const execFileAsync = promisify(execFile)

describe('command dispatch e2e', () => {
  const deps = createDepsWithoutLocale()

  it('tianji --help lists all commands and global flags', async () => {
    const { exitCode, stdout } = await runCommand(['--help'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('tianji run <prompt>')
    expect(stdout).toContain('tianji register <url>')
    expect(stdout).toContain('tianji daemon <subcommand>')
    expect(stdout).toContain('tianji log')
    expect(stdout).toContain('tianji chat')
    expect(stdout).toContain('-h, --help')
    expect(stdout).toContain('-V, --version')
  })

  it('tianji help is equivalent to --help', async () => {
    const { exitCode, stdout } = await runCommand(['help'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Usage:')
  })

  it('tianji -V outputs version', async () => {
    const { exitCode, stdout } = await runCommand(['-V'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/tianji v\d+\.\d+\.\d+/)
  })

  it('tianji --version outputs version', async () => {
    const { exitCode, stdout } = await runCommand(['--version'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toMatch(/tianji v\d+\.\d+\.\d+/)
  })

  it('tianji run --help shows run-specific help', async () => {
    const { exitCode, stdout } = await runCommand(['run', '--help'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('<prompt>')
    expect(stdout).not.toContain('tianji daemon')
  })

  it('tianji daemon --help shows subcommand list', async () => {
    const { exitCode, stdout } = await runCommand(['daemon', '--help'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('start')
    expect(stdout).toContain('stop')
    expect(stdout).toContain('restart')
    expect(stdout).toContain('--fg')
  })

  it('tianji log --help shows --follow and --lines', async () => {
    const { exitCode, stdout } = await runCommand(['log', '--help'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('--follow')
    expect(stdout).toContain('--lines')
  })

  it('tianji register --help shows register usage', async () => {
    const { exitCode, stdout } = await runCommand(['register', '--help'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('tianji register <url>')
    expect(stdout).toContain('<url>')
  })

  it('tianji help daemon is equivalent to daemon --help', async () => {
    const { exitCode, stdout } = await runCommand(['help', 'daemon'], deps)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('start')
    expect(stdout).toContain('stop')
  })

  it('no args exits 2 with concise error (no full help dump)', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli([], deps)
    expect(exitCode).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/Missing command/))
    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringMatching(/tianji run <prompt>/))
    stderrSpy.mockRestore()
  })

  it('unknown command exits 2 with error', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli(['wat'], deps)
    expect(exitCode).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/Unknown command "wat"/))
    stderrSpy.mockRestore()
  })

  it('daemon without subcommand exits 2', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli(['daemon'], deps)
    expect(exitCode).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/Missing subcommand/))
    stderrSpy.mockRestore()
  })

  it('daemon with unknown subcommand exits 2', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli(['daemon', 'fly'], deps)
    expect(exitCode).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/Unknown subcommand "fly"/))
    stderrSpy.mockRestore()
  })

  it('run without prompt exits 2', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli(['run'], deps)
    expect(exitCode).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/Missing required argument/))
    stderrSpy.mockRestore()
  })

  it('register without url exits 2', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli(['register'], deps)
    expect(exitCode).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringMatching(/Missing required argument/))
    stderrSpy.mockRestore()
  })
})

describe('locale-aware output e2e', () => {
  it('locale=zh-CN renders help in chinese', async () => {
    const { exitCode, stdout } = await runCommand(['--help'], createDepsWithLocale('zh-CN'))
    expect(exitCode).toBe(0)
    expect(stdout).toContain('用法:')
    expect(stdout).toContain('全局选项:')
    expect(stdout).not.toContain('Usage:')
    expect(stdout).not.toContain('Global flags:')
  })

  it('locale=en renders help in english', async () => {
    const { exitCode, stdout } = await runCommand(['--help'], createDepsWithLocale('en'))
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Usage:')
    expect(stdout).toContain('Global flags:')
  })

  it('locale=zh-CN error messages are in chinese', async () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitCode = await runCli(['wat'], createDepsWithLocale('zh-CN'))
    expect(exitCode).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('未知命令'))
    stderrSpy.mockRestore()
  })

  it('locale=zh-CN command-level help is in chinese', async () => {
    const { exitCode, stdout } = await runCommand(
      ['daemon', '--help'],
      createDepsWithLocale('zh-CN')
    )
    expect(exitCode).toBe(0)
    expect(stdout).toContain('子命令:')
    expect(stdout).toContain('启动后台守护进程')
  })

  it('no locale configured falls back to en', async () => {
    const { exitCode, stdout } = await runCommand(['--help'], createDepsWithoutLocale())
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Usage:')
  })
})

describe('command behavior regression', () => {
  it('log --lines 20 passes correct options to followCliLog', async () => {
    const spy = vi.fn(async () => undefined)
    const deps = createDepsWithoutLocale({ followCliLog: spy })
    await runCommand(['log', '--lines', '20'], deps)
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ locale: expect.any(String) }),
      expect.objectContaining({ lines: 20 })
    )
  })

  it('log defaults to lines=100', async () => {
    const spy = vi.fn(async () => undefined)
    const deps = createDepsWithoutLocale({ followCliLog: spy })
    await runCommand(['log'], deps)
    expect(spy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ lines: 100 })
    )
  })

  it('version output is consistent between -V and --version', async () => {
    const deps = createDepsWithoutLocale()
    const { stdout: short } = await runCommand(['-V'], deps)
    const { stdout: long } = await runCommand(['--version'], deps)
    expect(short).toBe(long)
  })

  it('workspace tianji script preserves concise unknown-command output', async () => {
    const commandResult = execFileAsync('pnpm', ['tianji', 'wat'], {
      cwd: '/workspaces/dev_docker/tianji-ai',
    })

    await expect(commandResult).rejects.toMatchObject({
      code: 2,
      stderr: 'Unknown command "wat". Run \'tianji --help\' for usage.\n',
    })

    await expect(commandResult).rejects.not.toMatchObject({
      stdout: expect.stringContaining('undefined'),
    })

    await expect(commandResult).rejects.not.toMatchObject({
      stdout: expect.stringContaining('ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL'),
    })
  }, 120_000)
})
