import { type AgentSession, DaemonServer, type UnifiedRuntimeEntry } from '@tianji/agent'

import type { UserConfigPaths } from '../../config.js'

import { createStubSession } from './daemon-subprocess.js'

async function main(): Promise<void> {
  const pathsRaw = process.env.TIANJI_TEST_DAEMON_PATHS
  const chunksRaw = process.env.TIANJI_TEST_DAEMON_CHUNKS

  if (!pathsRaw) {
    throw new Error('Missing TIANJI_TEST_DAEMON_PATHS')
  }

  const paths = JSON.parse(pathsRaw) as UserConfigPaths
  const chunks = chunksRaw === undefined ? [] : (JSON.parse(chunksRaw) as readonly string[])
  const live = createStubSession(chunks)
  const session: AgentSession = live.session
  const entry: UnifiedRuntimeEntry = {
    run: async () => ({
      sessionId: session.sessionId,
      runId: 'run_test' as never,
      events: session.queryWithGraph({} as never, { initialState: { input: '' } } as never),
    }),
    resume: async () => {
      throw new Error('test daemon subprocess resume is not implemented')
    },
    cancel: async () => undefined,
    stream: () => {
      throw new Error('test daemon subprocess stream is not implemented')
    },
  }

  const server = new DaemonServer({
    entry,
    bus: live.bus,
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
