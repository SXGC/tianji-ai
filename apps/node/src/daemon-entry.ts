import { pathToFileURL } from 'node:url'

import { DaemonServer, createAgentSession } from '@tianji/agent'

import { loadUserConfigContext } from './config.js'
import { createI18n, detectLocale } from './i18n/index.js'
import { logDebug, logInfo } from './logger.js'
import {
  deriveControlPlaneAgentList,
  readStoredControlPlaneConfig,
} from './node-runtime/controlplane-config.js'
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
  await logInfo(context.paths, ['daemon'], 'Daemon server listening', {
    port: server.port,
  })

  process.stdout.write(`${i18n.t('daemon.listening', { port: server.port })}\n`)

  // 如果用户配置中包含 controlplane 配置，则启动 controlplane 连接
  const controlPlaneConfig = readStoredControlPlaneConfig(context.config)
  let controlPlaneHandle: ControlPlaneRuntimeHandle | null = null
  if (controlPlaneConfig) {
    await logDebug(context.paths, ['daemon', 'controlplane'], 'Loaded control plane config', {
      baseUrl: controlPlaneConfig.baseUrl,
      nodeId: controlPlaneConfig.nodeId,
    })
    const runtime = createControlPlaneRuntime({
      ...controlPlaneConfig,
      agentList: deriveControlPlaneAgentList(context.config, controlPlaneConfig.version),
    })
    try {
      await runtime.connection.start()
      controlPlaneHandle = runtime
      await logInfo(
        context.paths,
        ['daemon', 'controlplane'],
        'Control plane connection established',
        {
          baseUrl: controlPlaneConfig.baseUrl,
          nodeId: controlPlaneConfig.nodeId,
        }
      )
    } catch (error) {
      await logInfo(context.paths, ['daemon', 'controlplane'], 'Control plane connection failed', {
        baseUrl: controlPlaneConfig.baseUrl,
        nodeId: controlPlaneConfig.nodeId,
        error: error instanceof Error ? error.message : String(error),
      })
      // controlplane 连接失败时 daemon 继续以本地模式运行
      process.stderr.write('Warning: controlplane connection failed, running in local-only mode\n')
    }
  }

  const shutdown = async (signal: NodeJS.Signals) => {
    await logInfo(context.paths, ['daemon'], 'Daemon shutdown signal received', {
      signal,
    })
    controlPlaneHandle?.connection.stop()
    void server.shutdown().finally(() => process.exit(0))
  }
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })
}

// 作为独立子进程被 fork 时，直接执行守护进程逻辑
const _isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (_isMain) {
  await runDaemonEntry()
}
