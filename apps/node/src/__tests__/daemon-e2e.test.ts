import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
/**
 * Daemon 子命令模式的端到端集成测试。
 *
 * 验证 DaemonServer、DaemonClient、临时路径文件和 runCli 命令处理
 * 之间的集成行为，不 mock 内部 daemon 协议。
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { type AgentSession, DaemonClient, DaemonServer } from '@tianji/agent'
import type { RunId, RuntimeEvent, SessionId } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import type { UserConfigPaths } from '../config.js'
import type { RunCommandDependencies } from '../main.js'
import { runCli } from '../main.js'

import { captureStdout, createTempCliPaths } from './helpers/cli-test-utils.js'

interface LiveDaemonHandle {
  readonly client: DaemonClient
  readonly paths: UserConfigPaths
  readonly cleanup: () => Promise<void>
}

async function setupLiveDaemon(
  session: AgentSession,
  providedPaths?: UserConfigPaths
): Promise<LiveDaemonHandle> {
  const temp = providedPaths === undefined ? await createTempCliPaths() : undefined
  const paths = providedPaths ?? temp!.paths
  const server = new DaemonServer({
    session,
    paths: {
      daemonPortPath: paths.daemonPortPath,
      daemonPidPath: paths.daemonPidPath,
    },
  })
  await server.listen(0)
  const portContent = await readFile(paths.daemonPortPath, 'utf8')
  const port = Number.parseInt(portContent.trim(), 10)
  const client = new DaemonClient({ host: '127.0.0.1', port })

  return {
    client,
    paths,
    cleanup: async () => {
      await server.shutdown()
      await temp?.cleanup()
    },
  }
}

function createStubSession(chunks: readonly string[]): AgentSession {
  const sessionId = `session_stub_${Date.now()}` as SessionId

  return {
    sessionId,
    abort: () => undefined,
    async *query(_prompt: string): AsyncIterable<RuntimeEvent> {
      const runId = `run_${Date.now()}` as RunId
      const messageId = `msg_${Date.now()}`

      for (let i = 0; i < chunks.length; i++) {
        yield {
          type: 'message.delta',
          runId,
          messageId,
          sequence: i,
          channel: 'text',
          payload: { content: chunks[i] },
          timestamp: Date.now(),
        }
      }

      yield {
        type: 'run.completed',
        runId,
        sessionId,
        triggerType: 'new',
        timestamp: Date.now(),
      }
    },
  }
}

function createRecordingSession(prompts: string[]): AgentSession {
  const sessionId = `session_recording_${Date.now()}` as SessionId

  return {
    sessionId,
    abort: () => undefined,
    async *query(prompt: string): AsyncIterable<RuntimeEvent> {
      prompts.push(prompt)
      const runId = `run_${Date.now()}` as RunId
      yield {
        type: 'message.delta',
        runId,
        messageId: `msg_${Date.now()}`,
        sequence: 0,
        channel: 'text',
        payload: { content: prompt },
        timestamp: Date.now(),
      }
      yield {
        type: 'run.completed',
        runId,
        sessionId,
        triggerType: 'new',
        timestamp: Date.now(),
      }
    },
  }
}

async function runCommand(argv: readonly string[], deps: RunCommandDependencies) {
  let exitCode = 0
  const stdout = await captureStdout(async () => {
    exitCode = await runCli(argv, deps)
  })
  return { exitCode, stdout }
}

async function collectEvents(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

async function expectDaemonFilesRemoved(paths: UserConfigPaths): Promise<void> {
  await expect(access(paths.daemonPortPath)).rejects.toThrow()
  await expect(access(paths.daemonPidPath)).rejects.toThrow()
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

const execFileAsync = promisify(execFile)

describe('daemon e2e', () => {
  it('boots a live daemon and responds to ping', async () => {
    const live = await setupLiveDaemon(createStubSession(['hello']))

    try {
      const ping = await live.client.ping()
      expect(ping.pid).toBeGreaterThan(0)
      expect(ping.sessionId).toBeTruthy()
    } finally {
      await live.cleanup()
    }
  }, 15_000)
})

describe('daemon start/status/stop', () => {
  it('completes foreground daemon lifecycle', async () => {
    const live = await setupLiveDaemon(createStubSession(['hello from daemon']))

    try {
      const ping = await live.client.ping()
      expect(ping.sessionId).toBeTruthy()

      const events = await collectEvents(live.client.sendChat('hello'))
      expect(events.some((event) => event.type === 'message.delta')).toBe(true)
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('prints daemon running info for daemon status', async () => {
    const live = await setupLiveDaemon(createStubSession(['status ok']))
    try {
      const result = await runCommand(['daemon', 'status'], {
        getUserConfigPaths: () => live.paths,
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Daemon running')
      expect(result.stdout).toContain('sessionId=')
      expect(result.stdout).toContain('controlplane=disabled')
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('stops a running daemon through daemon stop', async () => {
    const live = await setupLiveDaemon(createStubSession(['bye']))
    try {
      const result = await runCommand(['daemon', 'stop'], {
        getUserConfigPaths: () => live.paths,
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Daemon stopped')
      // 等待 server 异步完成文件删除（#handleShutdown 是 fire-and-forget）
      await live.cleanup()
      await expectDaemonFilesRemoved(live.paths)
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('reports already running when daemon start is called with daemon active', async () => {
    const live = await setupLiveDaemon(createStubSession(['already']))
    try {
      const result = await runCommand(['daemon', 'start', '--fg'], {
        getUserConfigPaths: () => live.paths,
        runDaemonEntry: vi.fn(async () => undefined),
        loadConfig: async () => ({
          controlPlane: { baseUrl: 'http://localhost:3000', enrollmentToken: 'tok', nodeId: 'n1' },
        }),
      })

      // daemon start 发现 ping 成功，应打印 "already running" 并返回 0，不调用 runDaemonEntry
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Daemon already running')
      expect(result.stdout).toContain('pid=')
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('returns promptly after background daemon start completes', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    const homeDir = join(paths.configDir, 'home')
    const xdgConfigHome = join(homeDir, '.config')
    const runtimeConfigDir = join(xdgConfigHome, 'tianji-ai')

    try {
      await execFileAsync('pnpm', ['build'], {
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
      })

      const cliEntryPath = fileURLToPath(new URL('../../bin/tianji.mjs', import.meta.url))
      await mkdir(runtimeConfigDir, { recursive: true })
      await writeFile(
        join(runtimeConfigDir, 'tianji.json'),
        JSON.stringify({
          agents: {
            defaultAgent: 'default',
            items: {
              default: {
                model: 'openai/gpt-4.1',
              },
            },
          },
          controlPlane: {
            baseUrl: 'http://127.0.0.1:3000',
            enrollmentToken: 'test-token',
            nodeId: 'test-node',
          },
        }),
        'utf8'
      )

      const child = spawn(process.execPath, [cliEntryPath, 'daemon', 'start'], {
        cwd: new URL('../..', import.meta.url),
        env: {
          ...process.env,
          HOME: homeDir,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer | string) => {
        stdoutChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      })
      child.stderr.on('data', (chunk: Buffer | string) => {
        stderrChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      })

      const exitCode = await Promise.race([
        new Promise<number | null>((resolve, reject) => {
          child.once('error', reject)
          child.once('exit', resolve)
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            child.kill('SIGTERM')
            reject(new Error('daemon start did not exit promptly'))
          }, 3_000)
        }),
      ])

      const stdout = Buffer.concat(stdoutChunks).toString('utf8')
      const stderr = Buffer.concat(stderrChunks).toString('utf8')

      expect(exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0)
      expect(stderr).toBe('')
      expect(stdout.length).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  }, 15_000)

  it('returns non-zero when daemon stop is called with no daemon running', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    try {
      const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const exitCode = await runCli(['daemon', 'stop'], {
        getUserConfigPaths: () => paths,
      })
      stderrSpy.mockRestore()
      expect(exitCode).toBe(1)
    } finally {
      await cleanup()
    }
  })
})

describe('daemon restart', () => {
  it('starts a fresh daemon when restart is called with no daemon running', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    try {
      const runDaemonEntry = vi.fn(async () => undefined)
      const result = await runCommand(['daemon', 'restart', '--fg'], {
        getUserConfigPaths: () => paths,
        runDaemonEntry,
      })

      expect(result.exitCode).toBe(0)
      expect(runDaemonEntry).toHaveBeenCalledOnce()
    } finally {
      await cleanup()
    }
  }, 15_000)

  it('restarts a running daemon in foreground mode', async () => {
    const first = await setupLiveDaemon(createStubSession(['first']))
    const replacement = vi.fn(async () => undefined)

    const result = await runCommand(['daemon', 'restart', '--fg'], {
      getUserConfigPaths: () => first.paths,
      runDaemonEntry: replacement,
    })

    expect(result.exitCode).toBe(0)
    expect(replacement).toHaveBeenCalledOnce()

    await first.cleanup()
  }, 15_000)

  it('cleans stale daemon files before foreground start', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    try {
      await writeFile(paths.daemonPortPath, '9999', 'utf8')
      await writeFile(paths.daemonPidPath, '123456', 'utf8')

      const runDaemonEntry = vi.fn(async () => {
        expect(await pathExists(paths.daemonPortPath)).toBe(false)
        expect(await pathExists(paths.daemonPidPath)).toBe(false)
      })

      const result = await runCommand(['daemon', 'start', '--fg'], {
        getUserConfigPaths: () => paths,
        runDaemonEntry,
        loadConfig: async () => ({
          controlPlane: { baseUrl: 'http://localhost:3000', enrollmentToken: 'tok', nodeId: 'n1' },
        }),
      })

      expect(result.exitCode).toBe(0)
      expect(runDaemonEntry).toHaveBeenCalledOnce()
    } finally {
      await cleanup()
    }
  }, 15_000)
})

describe('chat and end-to-end flow', () => {
  it('returns non-zero when chat runs without daemon', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    try {
      const exitCode = await runCli(['chat'], {
        getUserConfigPaths: () => paths,
      })
      expect(exitCode).toBeGreaterThan(0)
    } finally {
      await cleanup()
    }
  })

  it('streams one chat turn through the live daemon client', async () => {
    const live = await setupLiveDaemon(createStubSession(['hello', ' world']))
    try {
      const events = await collectEvents(live.client.sendChat('hello'))
      const deltas = events.filter((event) => event.type === 'message.delta')
      expect(deltas).toHaveLength(2)
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('preserves the same daemon session across multiple chat turns', async () => {
    const prompts: string[] = []
    const live = await setupLiveDaemon(createRecordingSession(prompts))
    try {
      await collectEvents(live.client.sendChat('first'))
      await collectEvents(live.client.sendChat('second'))
      expect(prompts).toEqual(['first', 'second'])
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('completes start -> status -> chat -> stop -> status failed journey', async () => {
    const live = await setupLiveDaemon(createStubSession(['journey ok']))
    try {
      const status1 = await runCommand(['daemon', 'status'], {
        getUserConfigPaths: () => live.paths,
      })
      expect(status1.exitCode).toBe(0)

      const events = await collectEvents(live.client.sendChat('hello'))
      expect(events.some((event) => event.type === 'run.completed')).toBe(true)

      const stop = await runCommand(['daemon', 'stop'], {
        getUserConfigPaths: () => live.paths,
      })
      expect(stop.exitCode).toBe(0)

      const status2 = await runCli(['daemon', 'status'], {
        getUserConfigPaths: () => live.paths,
      })
      expect(status2).toBe(1)
    } finally {
      await live.cleanup()
    }
  }, 15_000)
})
