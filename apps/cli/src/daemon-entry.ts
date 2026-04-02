import { pathToFileURL } from 'node:url'

import { DaemonServer, createAgentSession, loadAgentContext } from '@tianji/agent'

import { createI18n, detectLocale } from './i18n/index.js'

export async function runDaemonEntry(): Promise<void> {
  const context = await loadAgentContext()
  const i18n = createI18n(detectLocale(context.config))
  const session = createAgentSession(context)
  const server = new DaemonServer({
    session,
    paths: {
      daemonPortPath: context.paths.daemonPortPath,
      daemonPidPath: context.paths.daemonPidPath,
    },
  })
  await server.listen(0)

  process.stdout.write(`${i18n.t('daemon.listening', { port: server.port })}\n`)

  const shutdown = () => {
    void server.shutdown().finally(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// 作为独立子进程被 fork 时，直接执行守护进程逻辑
const _isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (_isMain) {
  void runDaemonEntry()
}
