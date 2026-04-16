import { type ChildProcess, spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serve } from '@hono/node-server'
import { createMemorySink, createObserverLogger } from '@tianji/observer'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { createDatabase } from '../db/index.js'

const nodeAppDir = fileURLToPath(new URL('../../../../apps/node', import.meta.url))
const nodeDistBinPath = fileURLToPath(new URL('../../../../apps/node/dist/bin.js', import.meta.url))
const fakeAcpAgentPath = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url))

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
      await waitForNode(`${env.baseUrl}/api/ui/nodes`, 'node-e2e-001')

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
      env.db.close()
      env.server.close()
    }
  }, 20000)

  it('leases a created task command to the connected node', async () => {
    const env = await setupTestEnv('node-e2e-002')

    try {
      nodeProcess = env.nodeProcess
      await waitForNode(`${env.baseUrl}/api/ui/nodes`, 'node-e2e-002')

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
      env.db.close()
      env.server.close()
    }
  }, 20000)
})

async function setupTestEnv(nodeId: string): Promise<{
  baseUrl: string
  db: ReturnType<typeof createDatabase>
  monitor: ReturnType<typeof createApp>['monitor']
  server: ReturnType<typeof serve>
  nodeProcess: ChildProcess
  stdoutChunks: Buffer[]
  stderrChunks: Buffer[]
}> {
  const baseDir = await mkdtemp(join(tmpdir(), 'tianji-cp-node-e2e-'))
  const configDir = join(baseDir, 'config')
  const homeDir = join(baseDir, 'home')
  const port = await allocatePort()
  const db = createDatabase(':memory:')
  const now = Date.now()

  await assertNodeDistReady(nodeDistBinPath)

  db.raw
    .prepare('INSERT INTO enrollment_tokens(token, created_at) VALUES(?, ?)')
    .run('e2e-token', now)

  const sink = createMemorySink()
  const logger = createObserverLogger({ sinks: [sink] })
  const { app, monitor } = createApp(db, logger)
  monitor.start()
  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })

  await mkdir(configDir, { recursive: true })
  await mkdir(homeDir, { recursive: true })
  await writeFile(join(configDir, 'tianji.json'), '{}', 'utf8')

  const configPath = join(configDir, 'tianji.json')
  const registerUrl = `http://127.0.0.1:${port}/register?enrollment-token=e2e-token`

  await writeFile(configPath, '{}', 'utf8')

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
    configPath,
    JSON.stringify({
      agents: {
        defaultAgent: 'default',
        items: {
          default: {
            command: '/usr/bin/env',
            args: ['node', fakeAcpAgentPath],
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

async function waitForNode(url: string, nodeId: string): Promise<void> {
  const deadline = Date.now() + 8000

  while (Date.now() < deadline) {
    const response = await fetch(url)
    const nodes = (await response.json()) as Array<{ nodeId: string }>
    if (nodes.some((node) => node.nodeId === nodeId)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  throw new Error(`Timed out waiting for node ${nodeId}`)
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
