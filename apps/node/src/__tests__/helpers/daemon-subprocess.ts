import { type ChildProcess, spawn } from 'node:child_process'
import { access, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { type AgentSession, DaemonClient } from '@tianji/agent'
import type { DomainEvent, DomainEventEnvelope, EventBus, RunId, SessionId } from '@tianji/shared'
import { createEventBus } from '@tianji/shared'

import type { UserConfigPaths } from '../../config.js'

interface SubprocessDaemonHandle {
  readonly client: DaemonClient
  readonly paths: UserConfigPaths
  readonly cleanup: () => Promise<void>
}

interface SpawnedDaemonProcess {
  readonly child: ChildProcess
  readonly stdoutChunks: Buffer[]
  readonly stderrChunks: Buffer[]
}

export interface LiveStubSession {
  readonly session: AgentSession
  readonly bus: EventBus
}

export function wrapRunEnvelope(event: DomainEvent): DomainEventEnvelope {
  const runId = 'runId' in event ? String(event.runId) : 'test-run'
  return {
    eventId: `evt_${event.type}_${Date.now()}`,
    type: event.type,
    occurredAt: new Date().toISOString(),
    correlationId: runId,
    causationId: null,
    sequence: 1,
    aggregateType: 'Run',
    aggregateId: runId,
    source: { processKind: 'daemon', processId: String(process.pid) },
    payload: event,
  }
}

export function createStubSession(chunks: readonly string[]): LiveStubSession {
  const sessionId = `session_stub_${Date.now()}` as SessionId
  const bus = createEventBus({ lagSink: () => undefined })

  return {
    bus,
    session: {
      sessionId,
      abort: () => undefined,
      close: () => undefined,
      async *queryWithGraph(): AsyncIterable<DomainEvent> {
        const runId = `run_${Date.now()}` as RunId
        const messageId = `msg_${Date.now()}`

        for (let i = 0; i < chunks.length; i++) {
          const event: DomainEvent = {
            type: 'MessageDelta',
            runId,
            messageId,
            sequence: i,
            channel: 'text',
            payload: { content: chunks[i] },
            timestamp: Date.now(),
          }
          bus.publish(wrapRunEnvelope(event))
          await new Promise<void>((resolve) => queueMicrotask(resolve))
          yield event
        }

        const completedEvent: DomainEvent = {
          type: 'RunCompleted',
          runId,
          sessionId,
          triggerType: 'new',
          timestamp: Date.now(),
        }
        bus.publish(wrapRunEnvelope(completedEvent))
        await new Promise<void>((resolve) => queueMicrotask(resolve))
        yield completedEvent
      },
    },
  }
}

async function waitForFileContent(filePath: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const content = (await readFile(filePath, 'utf8')).trim()
      if (content.length > 0) {
        return content
      }
    } catch {
      // 子进程可能正在创建、重写或删除状态文件，继续轮询即可。
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Timed out waiting for daemon file: ${filePath}`)
}

function collectProcessOutput(processHandle: ChildProcess): SpawnedDaemonProcess {
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []

  processHandle.stdout?.on('data', (chunk: Buffer | string) => {
    stdoutChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  })
  processHandle.stderr?.on('data', (chunk: Buffer | string) => {
    stderrChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  })

  return {
    child: processHandle,
    stdoutChunks,
    stderrChunks,
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  await Promise.race([
    new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.once('close', () => resolve())
    }),
    new Promise<void>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Timed out waiting for child process ${child.pid}`)),
        timeoutMs
      )
    }),
  ])
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }

  child.kill('SIGTERM')

  try {
    await waitForChildExit(child)
  } catch {
    child.kill('SIGKILL')
    await waitForChildExit(child)
  }
}

async function cleanupDaemonArtifacts(paths: UserConfigPaths): Promise<void> {
  await rm(paths.configDir, { recursive: true, force: true })
}

async function spawnDaemonChild(
  paths: UserConfigPaths,
  chunks: readonly string[]
): Promise<SpawnedDaemonProcess> {
  const entryPath = fileURLToPath(new URL('./daemon-subprocess-entry.ts', import.meta.url))
  const child = spawn('pnpm', ['exec', 'tsx', entryPath], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    env: {
      ...process.env,
      TIANJI_TEST_DAEMON_PATHS: JSON.stringify(paths),
      TIANJI_TEST_DAEMON_CHUNKS: JSON.stringify([...chunks]),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const spawned = collectProcessOutput(child)

  const exitPromise = new Promise<number | null>((resolve) => {
    child.once('exit', resolve)
  })

  try {
    const portContent = await waitForFileContent(paths.daemonPortPath)
    const port = Number.parseInt(portContent, 10)
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Invalid daemon port content: ${portContent}`)
    }

    const client = new DaemonClient({ host: '127.0.0.1', port })
    try {
      await pingWithTimeout(client)
    } finally {
      client.close()
    }

    return spawned
  } catch (error) {
    const stdout = Buffer.concat(spawned.stdoutChunks).toString('utf8')
    const stderr = Buffer.concat(spawned.stderrChunks).toString('utf8')
    const message = error instanceof Error ? error.message : String(error)
    try {
      child.kill('SIGTERM')
      await Promise.race([exitPromise, waitForChildExit(child).catch(() => undefined)])
    } finally {
      await cleanupDaemonArtifacts(paths)
    }

    throw new Error(`${message}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
}

export async function setupSubprocessDaemon(
  sessionChunks: readonly string[],
  paths: UserConfigPaths
): Promise<SubprocessDaemonHandle> {
  const childProcess = await spawnDaemonChild(paths, sessionChunks)
  const portContent = await waitForFileContent(paths.daemonPortPath)
  const port = Number.parseInt(portContent, 10)
  const client = new DaemonClient({ host: '127.0.0.1', port })

  return {
    client,
    paths,
    cleanup: async () => {
      try {
        try {
          await client.close()
        } finally {
          await stopChildProcess(childProcess.child)
        }
      } finally {
        await cleanupDaemonArtifacts(paths)
      }
    },
  }
}

async function pingWithTimeout(client: DaemonClient, timeoutMs = 2_000): Promise<void> {
  let timeoutHandle: NodeJS.Timeout | undefined

  try {
    await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Timed out waiting for daemon ping after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }
  }
}
