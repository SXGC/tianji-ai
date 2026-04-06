import { pathToFileURL } from 'node:url'

import { DaemonServer, createAgentSession } from '@tianji/agent'

import { loadUserConfigContext } from './config.js'
import { createI18n, detectLocale } from './i18n/index.js'
import { readStoredControlPlaneConfig } from './node-runtime/controlplane-config.js'
import {
  type ControlPlaneRuntimeHandle,
  createControlPlaneRuntime,
} from './node-runtime/controlplane-runtime.js'

export async function runDaemonEntry(): Promise<void> {
  const context = await loadUserConfigContext()
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

  // 如果用户配置中包含 controlplane 配置，则启动 controlplane 连接
  const controlPlaneConfig = readStoredControlPlaneConfig(context.config)
  let controlPlaneHandle: ControlPlaneRuntimeHandle | null = null
  if (controlPlaneConfig) {
    const runtime = createControlPlaneRuntime({
      ...controlPlaneConfig,
      agentList: [],
    })
    try {
      await runtime.connection.start()
      controlPlaneHandle = runtime
    } catch {
      // controlplane 连接失败时 daemon 继续以本地模式运行
      process.stderr.write('Warning: controlplane connection failed, running in local-only mode\n')
    }
  }

  const shutdown = () => {
    controlPlaneHandle?.connection.stop()
    void server.shutdown().finally(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

// 作为独立子进程被 fork 时，直接执行守护进程逻辑
const _isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (_isMain) {
  await runDaemonEntry()
}
