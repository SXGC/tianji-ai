import { DaemonServer, createAgentSession, loadAgentContext } from '@tianji/agent'

export async function runDaemonEntry(): Promise<void> {
  const context = await loadAgentContext()
  const session = createAgentSession(context)
  const server = new DaemonServer({
    session,
    paths: {
      daemonPortPath: context.paths.daemonPortPath,
      daemonPidPath: context.paths.daemonPidPath,
    },
  })
  await server.listen(0)

  process.stdout.write(`Daemon listening on port ${server.port}\n`)

  const shutdown = () => {
    void server.shutdown().finally(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
