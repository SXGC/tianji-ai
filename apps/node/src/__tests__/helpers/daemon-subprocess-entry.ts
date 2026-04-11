import {
  type AgentExecutorFactory,
  type AgentSession,
  DaemonServer,
  type OrchestrationGraph,
} from '@tianji/agent'

import type { UserConfigPaths } from '../../config.js'

import { createStubSession } from './daemon-subprocess.js'

const testDefaultGraph: OrchestrationGraph = {
  id: 'test',
  name: 'test',
  version: 1,
  source: 'static',
  locked: false,
  state: {},
  nodes: [],
  edges: [],
}

const testExecutorFactory: AgentExecutorFactory = () => async () => ({})

async function main(): Promise<void> {
  const pathsRaw = process.env.TIANJI_TEST_DAEMON_PATHS
  const chunksRaw = process.env.TIANJI_TEST_DAEMON_CHUNKS

  if (!pathsRaw) {
    throw new Error('Missing TIANJI_TEST_DAEMON_PATHS')
  }

  const paths = JSON.parse(pathsRaw) as UserConfigPaths
  const chunks = chunksRaw === undefined ? [] : (JSON.parse(chunksRaw) as readonly string[])
  const session: AgentSession = createStubSession(chunks)

  const server = new DaemonServer({
    session,
    defaultGraph: testDefaultGraph,
    executorFactory: testExecutorFactory,
    paths: {
      daemonPortPath: paths.daemonPortPath,
      daemonPidPath: paths.daemonPidPath,
    },
  })

  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    await server.shutdown()
  }

  process.once('SIGTERM', () => {
    void shutdown().catch((error: unknown) => {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
      console.error(message)
      process.exit(1)
    })
  })

  process.once('SIGINT', () => {
    void shutdown().catch((error: unknown) => {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
      console.error(message)
      process.exit(1)
    })
  })

  await server.listen(0)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(message)
  process.exit(1)
})
