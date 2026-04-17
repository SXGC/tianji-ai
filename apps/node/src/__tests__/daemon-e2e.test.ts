import { execFile, spawn } from 'node:child_process'
/**
 * Daemon 子命令模式的端到端集成测试。
 *
 * 验证 DaemonServer、DaemonClient、临时路径文件和 runCli 命令处理
 * 之间的集成行为，不 mock 内部 daemon 协议。
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  type AgentSession,
  DaemonClient,
  DaemonServer,
  type UnifiedRuntimeEntry,
} from '@tianji/agent'
import { createEventBus } from '@tianji/shared'
import type { DomainEvent, DomainEventEnvelope, EventBus, RunId, SessionId } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import type { UserConfigPaths } from '../config.js'
import type { RunCommandDependencies } from '../main.js'
import { runCli } from '../main.js'

import { captureStdout, createTempCliPaths } from './helpers/cli-test-utils.js'
import {
  createStubSession,
  setupSubprocessDaemon,
  wrapRunEnvelope,
} from './helpers/daemon-subprocess.js'

const testDefaultGraph = {
  id: 'test',
  name: 'test',
  version: 1,
  source: 'static' as const,
  locked: false,
  state: {},
  nodes: [],
  edges: [],
}

interface LiveDaemonHandle {
  readonly client: DaemonClient
  readonly paths: UserConfigPaths
  readonly cleanup: () => Promise<void>
}

interface LiveDaemonSessionFactory {
  readonly session: AgentSession
  readonly bus: EventBus
}

async function setupLiveDaemon(
  live: LiveDaemonSessionFactory,
  providedPaths?: UserConfigPaths
): Promise<LiveDaemonHandle> {
  const temp = providedPaths === undefined ? await createTempCliPaths() : undefined
  const paths = providedPaths ?? temp!.paths
  const entry: UnifiedRuntimeEntry = {
    run: vi.fn(async (request) => ({
      sessionId: live.session.sessionId,
      runId: 'run_test' as never,
      events: live.session.queryWithGraph(
        {} as never,
        { initialState: { input: request.input } } as never
      ),
    })),
    resume: vi.fn(),
    cancel: vi.fn(),
    stream: vi.fn(),
  }
  const server = new DaemonServer({
    entry,
    bus: live.bus,
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

function createTestBus(): EventBus {
  return createEventBus({ lagSink: vi.fn(), errorSink: vi.fn() })
}

function createRecordingSession(prompts: string[]): LiveDaemonSessionFactory {
  const sessionId = `session_recording_${Date.now()}` as SessionId
  const bus = createTestBus()

  return {
    bus,
    session: {
      sessionId,
      abort: () => undefined,
      close: () => undefined,
      async *queryWithGraph(_graph, options): AsyncIterable<DomainEvent> {
        const prompt = String(options.initialState?.input ?? '')
        prompts.push(prompt)
        const runId = `run_${Date.now()}` as RunId
        const events: DomainEvent[] = [
          {
            type: 'MessageDelta',
            runId,
            messageId: `msg_${Date.now()}`,
            sequence: 0,
            channel: 'text',
            payload: { content: prompt },
            timestamp: Date.now(),
          },
          {
            type: 'RunCompleted',
            runId,
            sessionId,
            triggerType: 'new',
            timestamp: Date.now(),
          },
        ]

        for (const event of events) {
          bus.publish(wrapRunEnvelope(event))
          await new Promise<void>((resolve) => queueMicrotask(resolve))
          yield event
        }
      },
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

async function collectEvents(stream: AsyncIterable<DomainEvent>): Promise<DomainEvent[]> {
  const events: DomainEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

async function collectEnvelopes(
  stream: AsyncIterable<DomainEventEnvelope>
): Promise<DomainEventEnvelope[]> {
  const envelopes: DomainEventEnvelope[] = []
  for await (const envelope of stream) {
    envelopes.push(envelope)
  }
  return envelopes
}

async function expectDaemonFilesRemoved(paths: UserConfigPaths, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const portExists = await pathExists(paths.daemonPortPath)
    const pidExists = await pathExists(paths.daemonPidPath)
    if (!portExists && !pidExists) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

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
    const liveSession = createStubSession(['hello'])
    const live = await setupLiveDaemon(liveSession)

    try {
      const ping = await live.client.ping()
      expect(ping.pid).toBeGreaterThan(0)
      expect('sessionId' in ping).toBe(false)
    } finally {
      await live.cleanup()
    }
  }, 15_000)
})

describe('daemon start/status/stop', () => {
  it('completes foreground daemon lifecycle', async () => {
    const liveSession = createStubSession(['hello from daemon'])
    const live = await setupLiveDaemon(liveSession)

    try {
      const ping = await live.client.ping()
      expect('sessionId' in ping).toBe(false)

      const createdSession = await live.client.createSession()
      const events = await collectEnvelopes(live.client.sendChat('hello', createdSession.sessionId))
      expect(events.some((event) => event.type === 'MessageDelta')).toBe(true)
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('prints daemon running info for daemon status', async () => {
    const liveSession = createStubSession(['status ok'])
    const live = await setupLiveDaemon(liveSession)
    try {
      const result = await runCommand(['daemon', 'status'], {
        getUserConfigPaths: () => live.paths,
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Daemon running')
      expect(result.stdout).toContain('controlplane=disabled')
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('stops a running daemon through daemon stop', async () => {
    const { paths, cleanup: cleanupTemp } = await createTempCliPaths()
    try {
      const live = await setupSubprocessDaemon(['bye'], paths)
      try {
        const result = await runCommand(['daemon', 'stop'], {
          getUserConfigPaths: () => live.paths,
        })

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('stopped successfully')
        await expectDaemonFilesRemoved(live.paths)
      } finally {
        await live.cleanup()
      }
    } finally {
      await cleanupTemp()
    }
  }, 15_000)

  it('reports already running when daemon start is called with daemon active', async () => {
    const liveSession = createStubSession(['already'])
    const live = await setupLiveDaemon(liveSession)
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
      await writeFile(
        join(runtimeConfigDir, 'default-orchestration.json'),
        JSON.stringify(testDefaultGraph),
        'utf8'
      )

      const child = spawn(process.execPath, [cliEntryPath, 'daemon', 'start'], {
        cwd: new URL('../..', import.meta.url),
        env: {
          ...process.env,
          HOME: homeDir,
          OPENAI_API_KEY: 'test-key',
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

  it('restarts a running daemon in foreground mode', async () => {
    const { paths, cleanup: cleanupTemp } = await createTempCliPaths()
    const replacement = vi.fn(async () => undefined)

    try {
      const first = await setupSubprocessDaemon(['first'], paths)
      try {
        const result = await runCommand(['daemon', 'restart', '--fg'], {
          getUserConfigPaths: () => first.paths,
          runDaemonEntry: replacement,
          loadConfig: async () => ({
            controlPlane: {
              baseUrl: 'http://localhost:3000',
              enrollmentToken: 'tok',
              nodeId: 'n1',
            },
          }),
        })

        expect(result.exitCode).toBe(0)
        expect(replacement).toHaveBeenCalledOnce()
        await expectDaemonFilesRemoved(first.paths)
      } finally {
        await first.cleanup()
      }
    } finally {
      await cleanupTemp()
    }
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
    const liveSession = createStubSession(['hello', ' world'])
    const live = await setupLiveDaemon(liveSession)
    try {
      const createdSession = await live.client.createSession()
      const events = await collectEnvelopes(live.client.sendChat('hello', createdSession.sessionId))
      const deltas = events.filter((event) => event.type === 'MessageDelta')
      expect(deltas).toHaveLength(2)
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('preserves the same daemon session across multiple chat turns', async () => {
    const prompts: string[] = []
    const live = await setupLiveDaemon(createRecordingSession(prompts))
    try {
      const createdSession = await live.client.createSession()
      await collectEnvelopes(live.client.sendChat('first', createdSession.sessionId))
      await collectEnvelopes(live.client.sendChat('second', createdSession.sessionId))
      expect(prompts).toEqual(['first', 'second'])
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('completes start -> status -> chat -> stop -> status failed journey', async () => {
    const { paths, cleanup: cleanupTemp } = await createTempCliPaths()
    try {
      const live = await setupSubprocessDaemon(['journey ok'], paths)
      try {
        const status1 = await runCommand(['daemon', 'status'], {
          getUserConfigPaths: () => live.paths,
        })
        expect(status1.exitCode).toBe(0)

        const createdSession = await live.client.createSession()
        const events = await collectEnvelopes(
          live.client.sendChat('hello', createdSession.sessionId)
        )
        expect(events.some((event) => event.type === 'RunCompleted')).toBe(true)

        const stop = await runCommand(['daemon', 'stop'], {
          getUserConfigPaths: () => live.paths,
        })
        expect(stop.exitCode).toBe(0)
        await expectDaemonFilesRemoved(live.paths)

        const status2 = await runCli(['daemon', 'status'], {
          getUserConfigPaths: () => live.paths,
        })
        expect(status2).toBe(1)
      } finally {
        await live.cleanup()
      }
    } finally {
      await cleanupTemp()
    }
  }, 15_000)
})
