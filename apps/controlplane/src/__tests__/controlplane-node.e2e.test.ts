import { type ChildProcess, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import {
  type IncomingMessage,
  type ServerResponse,
  createServer as createHttpServer,
} from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serve } from '@hono/node-server'
import { createMemorySink, createObserverLogger } from '@tianji/observer'
import { SequenceCounter, createRuntimeEventPipeline } from '@tianji/runtime'
import { createEventBus } from '@tianji/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { createDatabase } from '../db/index.js'
import { SqliteEventLogStore } from '../storage/event-log-sqlite.js'
import { subscribeEventLog } from '../storage/event-log-subscriber.js'

const nodeAppDir = fileURLToPath(new URL('../../../../apps/node', import.meta.url))
const nodeDistBinPath = fileURLToPath(new URL('../../../../apps/node/dist/bin.js', import.meta.url))
const TEST_OPENAI_API_KEY = 'test-key'
const TEST_DEFAULT_GRAPH = {
  id: 'default',
  name: 'default',
  version: 1,
  source: 'static',
  locked: false,
  state: {
    input: { type: 'string' },
    output: { type: 'string' },
  },
  nodes: [
    {
      id: 'agent',
      type: 'agent',
      agent: 'default',
      input: ['input'],
      output: ['output'],
    },
  ],
  edges: [
    { from: '__start__', to: 'agent' },
    { from: 'agent', to: '__end__' },
  ],
} as const

describe('controlplane <-> node e2e', () => {
  let nodeProcess: ChildProcess | null = null

  afterEach(async () => {
    nodeProcess?.kill('SIGTERM')
    nodeProcess = null
  })

  it('fails fast when node dist entrypoint is missing', async () => {
    await expect(assertNodeDistReady('/tmp/tianji-missing-node-dist.js')).rejects.toThrow(
      'Missing built node entrypoint: /tmp/tianji-missing-node-dist.js. Run `pnpm build` before running controlplane-node e2e tests.'
    )
  })

  it('shows node and derived agents in ui after successful daemon registration', async () => {
    const env = await setupTestEnv('node-e2e-001')

    try {
      nodeProcess = env.nodeProcess
      await waitForNode(`${env.baseUrl}/api/ui/nodes`, 'node-e2e-001', {
        stdoutChunks: env.stdoutChunks,
        stderrChunks: env.stderrChunks,
      })

      const response = await fetch(`${env.baseUrl}/api/ui/nodes`)
      const nodes = (await response.json()) as Array<{
        nodeId: string
        status: string
        agents: Array<{ agentId: string; name: string }>
      }>
      expect(nodes.some((node) => node.nodeId === 'node-e2e-001')).toBe(true)
      expect(nodes.find((node) => node.nodeId === 'node-e2e-001')?.agents).toEqual([
        {
          agentId: 'default',
          type: 'native',
          name: 'default',
          version: '0.0.1',
        },
      ])
    } finally {
      await stopProcess(nodeProcess)
      nodeProcess = null
      env.monitor.stop()
      await env.closeLlmServer()
      env.db.close()
      env.server.close()
    }
  }, 20000)

  it('cancel 命令链路：POST cancel → node disconnect → TaskCancelled 落入 event_log，总延迟 < 3s', async () => {
    const env = await setupTestEnv('node-e2e-cancel', { llmMode: 'hang' })

    try {
      nodeProcess = env.nodeProcess
      await waitForNode(`${env.baseUrl}/api/ui/nodes`, 'node-e2e-cancel', {
        stdoutChunks: env.stdoutChunks,
        stderrChunks: env.stderrChunks,
      })

      // 1. 发 task.run，启动一个永不完成的任务
      const runResponse = await fetch(`${env.baseUrl}/api/copilot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-node-id': 'node-e2e-cancel',
          'x-agent-id': 'default',
        },
        body: JSON.stringify({
          method: 'agent/run',
          params: { agentId: 'default' },
          body: {
            threadId: 'thread-cancel-e2e-1',
            runId: 'run-cancel-e2e-1',
            messages: [{ id: 'm1', role: 'user', content: 'long running task' }],
            tools: [],
            context: [],
            forwardedProps: {},
            state: {},
          },
        }),
      })
      expect(runResponse.status).toBe(200)

      // 2. 等待任务行写入 tasks 表（copilot 路由创建任务后异步下发给 node）
      let taskId: string | undefined
      const taskDeadline = Date.now() + 5000
      while (Date.now() < taskDeadline && taskId === undefined) {
        const row = env.db.raw
          .prepare('SELECT task_id FROM tasks ORDER BY created_at DESC LIMIT 1')
          .get() as { task_id: string } | undefined
        taskId = row?.task_id
        if (taskId === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      expect(taskId).toBeDefined()

      // 3. 等 TaskStarted 事件落入 event_log，确认 node 已接手任务并开始执行
      const startedDeadline = Date.now() + 5000
      let taskStarted = false
      const taskStartedSql =
        "SELECT COUNT(*) AS c FROM event_log WHERE aggregate_id = ? AND type = 'TaskStarted'"
      while (Date.now() < startedDeadline && !taskStarted) {
        const row = env.db.raw.prepare(taskStartedSql).get(taskId) as { c: number }
        if (row.c > 0) {
          taskStarted = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(taskStarted).toBe(true)

      // 4. 发 cancel，记录起始时间
      const cancelStart = Date.now()
      const cancelResponse = await fetch(`${env.baseUrl}/api/copilot/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      })
      expect(cancelResponse.status).toBe(202)

      let cancelCommandInsertedAt: number | null = null
      let cancelCommandConsumedAt: number | null = null
      const cancelCommandDeadline = cancelStart + 3000
      const cancelCommandSql =
        "SELECT state FROM commands WHERE type = 'task.cancel' AND json_extract(payload, '$.taskId') = ? ORDER BY created_at DESC LIMIT 1"
      while (Date.now() < cancelCommandDeadline && cancelCommandConsumedAt === null) {
        const row = env.db.raw.prepare(cancelCommandSql).get(taskId) as
          | { state: string }
          | undefined
        if (row !== undefined) {
          cancelCommandInsertedAt ??= Date.now()
          if (row.state !== 'pending') {
            cancelCommandConsumedAt = Date.now()
            break
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }

      // 5. 轮询 event_log，等待 TaskCancelled 落表，限 3 秒内完成
      const cancelDeadline = cancelStart + 3000
      let cancelled = false
      let taskCancelledAt: number | null = null
      const taskCancelledSql =
        "SELECT COUNT(*) AS c FROM event_log WHERE aggregate_id = ? AND type = 'TaskCancelled'"
      while (Date.now() < cancelDeadline && !cancelled) {
        const row = env.db.raw.prepare(taskCancelledSql).get(taskId) as { c: number }
        if (row.c > 0) {
          cancelled = true
          taskCancelledAt = Date.now()
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      const totalLatencyMs = Date.now() - cancelStart
      const insertLatencyMs =
        cancelCommandInsertedAt === null ? 'missing' : String(cancelCommandInsertedAt - cancelStart)
      const consumeLatencyMs =
        cancelCommandConsumedAt === null ? 'missing' : String(cancelCommandConsumedAt - cancelStart)
      const eventLatencyMs =
        taskCancelledAt === null ? 'missing' : String(taskCancelledAt - cancelStart)
      const recentTaskEvents = env.db.raw
        .prepare(
          'SELECT type, aggregate_type, aggregate_id, payload_json FROM event_log WHERE aggregate_id = ? ORDER BY rowid DESC LIMIT 12'
        )
        .all(taskId) as Array<{
        type: string
        aggregate_type: string
        aggregate_id: string
        payload_json: string
      }>
      const cancelLogLines = Buffer.concat(env.stderrChunks)
        .toString('utf8')
        .split('\n')
        .filter(
          (line) =>
            line.includes('TaskCancelled') ||
            line.includes('RunCancelled') ||
            line.includes('cancel') ||
            line.includes('Cleaning up task execution resources')
        )
        .join('\n')
      const cancelMessage =
        `TaskCancelled 事件未在 3 秒内落入 event_log（总等待 ${totalLatencyMs}ms，` +
        `命令入表 ${insertLatencyMs}ms，命令消费 ${consumeLatencyMs}ms，事件落表 ${eventLatencyMs}ms）` +
        `\nrecent task events:\n${recentTaskEvents.map((event) => `${event.aggregate_type}:${event.type}:${event.aggregate_id}:${event.payload_json}`).join('\n')}` +
        `\nnode stderr(cancel):\n${cancelLogLines}`
      expect(cancelled, cancelMessage).toBe(true)
      expect(totalLatencyMs).toBeLessThan(3000)
    } finally {
      await stopProcess(nodeProcess)
      nodeProcess = null
      env.monitor.stop()
      await env.closeEventLog()
      await env.closeLlmServer()
      env.db.close()
      env.server.close()
    }
  }, 30000)

  it('leases a created task command to the connected node', async () => {
    const env = await setupTestEnv('node-e2e-002')

    try {
      nodeProcess = env.nodeProcess
      await waitForNode(`${env.baseUrl}/api/ui/nodes`, 'node-e2e-002', {
        stdoutChunks: env.stdoutChunks,
        stderrChunks: env.stderrChunks,
      })

      const createTaskResponse = await fetch(`${env.baseUrl}/api/copilot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-node-id': 'node-e2e-002',
          'x-agent-id': 'default',
        },
        body: JSON.stringify({
          method: 'agent/run',
          params: {
            agentId: 'default',
          },
          body: {
            threadId: 'thread-node-e2e-002',
            runId: 'run-node-e2e-002',
            messages: [{ id: 'msg-1', role: 'user', content: 'run integration task' }],
            tools: [],
            context: [],
            forwardedProps: {},
            state: {},
          },
        }),
      })

      expect(createTaskResponse.status).toBe(200)

      const createdTask = env.db.raw
        .prepare('SELECT task_id FROM tasks ORDER BY created_at DESC LIMIT 1')
        .get() as { task_id: string } | undefined

      expect(createdTask).toBeDefined()

      const deadline = Date.now() + 8000
      let taskStatus = 'pending'

      while (Date.now() < deadline) {
        const taskRow = env.db.raw
          .prepare('SELECT status FROM tasks WHERE task_id = ?')
          .get(createdTask!.task_id) as { status: string } | undefined
        taskStatus = taskRow?.status ?? 'pending'
        if (taskStatus !== 'pending') {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }

      expect(['running', 'completed']).toContain(taskStatus)
    } finally {
      await stopProcess(nodeProcess)
      nodeProcess = null
      env.monitor.stop()
      await env.closeLlmServer()
      env.db.close()
      env.server.close()
    }
  }, 20000)
})

interface SetupTestEnvOptions {
  readonly model?: string
  readonly llmMode?: 'complete' | 'hang'
}

async function setupTestEnv(
  nodeId: string,
  options: SetupTestEnvOptions = {}
): Promise<{
  baseUrl: string
  db: ReturnType<typeof createDatabase>
  monitor: ReturnType<typeof createApp>['monitor']
  server: ReturnType<typeof serve>
  nodeProcess: ChildProcess
  stdoutChunks: Buffer[]
  stderrChunks: Buffer[]
  closeEventLog: () => Promise<void>
  closeLlmServer: () => Promise<void>
}> {
  const baseDir = await mkdtemp(join(tmpdir(), 'tianji-cp-node-e2e-'))
  const homeDir = join(baseDir, 'home')
  const configDir = join(homeDir, '.config', 'tianji-ai')
  const port = await allocatePort()
  const db = createDatabase(':memory:')
  const now = Date.now()
  const llmServer = await startFakeOpenAiServer(options.llmMode ?? 'complete')

  await assertNodeDistReady(nodeDistBinPath)

  db.raw
    .prepare('INSERT INTO enrollment_tokens(token, created_at) VALUES(?, ?)')
    .run('e2e-token', now)

  const sink = createMemorySink()
  const logger = createObserverLogger({ sinks: [sink] })

  // 装配 cp 侧 EventBus + EventLog，使 /api/events 路由可以接收 node 上传的事件。
  // 不装配时 /api/events 不注册（见 app.ts），node forwarder 会拿到 404。
  // 注意：不传 emitEvent 以避免在无 ALS 上下文中调用 pipeline.emitEvent 报错。
  // cp 自身的 NodeRegistered 等事件对 e2e 测试不需要落 event_log。
  const bus = createEventBus({})
  const store = new SqliteEventLogStore(db.raw)
  const eventLogHandle = subscribeEventLog(bus, store, { logger })

  const { app, monitor } = createApp(db, logger, { bus })
  monitor.start()
  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })

  await mkdir(configDir, { recursive: true })
  await mkdir(homeDir, { recursive: true })
  await writeFile(
    join(configDir, 'tianji.json'),
    JSON.stringify({
      providers: {
        openai: {
          apiKey: TEST_OPENAI_API_KEY,
          baseUrl: llmServer.baseUrl,
        },
      },
    }),
    'utf8'
  )

  const configPath = join(configDir, 'tianji.json')
  const registerUrl = `http://127.0.0.1:${port}/register?enrollment-token=e2e-token`

  const registerProcess = spawn(
    '/usr/bin/env',
    ['node', nodeDistBinPath, 'daemon', 'start', '--fg', '--register', registerUrl],
    {
      cwd: nodeAppDir,
      env: {
        ...process.env,
        HOME: homeDir,
        XDG_CONFIG_HOME: baseDir,
        TIANJI_NODE_ID: nodeId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )

  await waitForProcessOutput(registerProcess, 'Daemon listening on port')
  await stopProcess(registerProcess)

  await writeFile(
    join(configDir, 'default-orchestration.json'),
    JSON.stringify(TEST_DEFAULT_GRAPH),
    'utf8'
  )

  await writeFile(
    configPath,
    JSON.stringify({
      providers: {
        openai: {
          apiKey: TEST_OPENAI_API_KEY,
          baseUrl: llmServer.baseUrl,
        },
      },
      agents: {
        defaultAgent: 'default',
        items: {
          default: {
            model: options.model ?? 'openai/gpt-4.1',
          },
        },
      },
      controlPlane: {
        baseUrl: `http://127.0.0.1:${port}`,
        enrollmentToken: 'e2e-token',
        nodeId,
      },
    }),
    'utf8'
  )

  const nodeProcess = spawn('/usr/bin/env', ['node', nodeDistBinPath, 'daemon', 'start', '--fg'], {
    cwd: nodeAppDir,
    env: {
      ...process.env,
      HOME: homeDir,
      XDG_CONFIG_HOME: baseDir,
      TIANJI_NODE_ID: nodeId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  nodeProcess.stdout?.on('data', (chunk) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })
  nodeProcess.stderr?.on('data', (chunk) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    db,
    monitor,
    server,
    nodeProcess,
    stdoutChunks,
    stderrChunks,
    closeEventLog: async () => {
      await eventLogHandle.close()
      await bus.close()
    },
    closeLlmServer: async () => {
      await llmServer.close()
    },
  }
}

async function startFakeOpenAiServer(
  mode: 'complete' | 'hang'
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const port = await allocatePort()
  const sockets = new Set<import('node:net').Socket>()
  const server = createHttpServer(
    async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.statusCode = 404
        res.end('not found')
        return
      }

      if (mode === 'hang') {
        req.on('close', () => {
          if (!res.writableEnded) {
            res.end()
          }
        })
        return
      }

      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'gpt-4.1',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      )
    }
  )

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}

/**
 * 确保 node e2e 所需的已构建 CLI 入口存在，避免测试以注册超时的假象失败。
 */
async function assertNodeDistReady(entrypointPath: string): Promise<void> {
  try {
    await access(entrypointPath)
  } catch {
    throw new Error(
      `Missing built node entrypoint: ${entrypointPath}. Run \`pnpm build\` before running controlplane-node e2e tests.`
    )
  }
}

async function waitForNode(
  url: string,
  nodeId: string,
  logs?: { stdoutChunks: Buffer[]; stderrChunks: Buffer[] }
): Promise<void> {
  const deadline = Date.now() + 8000

  while (Date.now() < deadline) {
    const response = await fetch(url)
    const nodes = (await response.json()) as Array<{ nodeId: string }>
    if (nodes.some((node) => node.nodeId === nodeId)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  const stdout = logs ? Buffer.concat(logs.stdoutChunks).toString('utf8') : ''
  const stderr = logs ? Buffer.concat(logs.stderrChunks).toString('utf8') : ''
  throw new Error(`Timed out waiting for node ${nodeId}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
}

async function stopProcess(process: ChildProcess | null): Promise<void> {
  if (process === null || process.exitCode !== null) {
    return
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      process.kill('SIGKILL')
    }, 2000)

    process.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })

    process.kill('SIGTERM')
  })
}

async function waitForProcessOutput(
  process: ChildProcess,
  expectedText: string,
  timeoutMs = 8000
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = ''

    const cleanup = (): void => {
      clearTimeout(timeout)
      process.stdout?.off('data', handleChunk)
      process.stderr?.off('data', handleChunk)
      process.off('exit', handleExit)
      process.off('error', handleError)
    }

    const finishIfMatched = (): void => {
      if (output.includes(expectedText)) {
        cleanup()
        resolve()
      }
    }

    const handleChunk = (chunk: Buffer | string): void => {
      output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
      finishIfMatched()
    }

    const handleExit = (): void => {
      cleanup()
      reject(new Error(`Process exited before output appeared: ${expectedText}\n${output}`))
    }

    const handleError = (error: Error): void => {
      cleanup()
      reject(error)
    }

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for process output: ${expectedText}\n${output}`))
    }, timeoutMs)

    process.stdout?.on('data', handleChunk)
    process.stderr?.on('data', handleChunk)
    process.once('exit', handleExit)
    process.once('error', handleError)
  })
}

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')))
        return
      }

      const { port } = address
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}
