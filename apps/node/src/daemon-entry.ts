import { pathToFileURL } from 'node:url'

import { DaemonServer, createAgentSession } from '@tianji/agent'

import { loadUserConfigContext } from './config.js'
import { createI18n, detectLocale } from './i18n/index.js'
import { getCliLogger, logDebug, logError, logInfo } from './logger.js'
import {
  deriveControlPlaneAgentList,
  readStoredControlPlaneConfig,
} from './node-runtime/controlplane-config.js'
import {
  type ControlPlaneRuntimeHandle,
  createControlPlaneRuntime,
} from './node-runtime/controlplane-runtime.js'

type DaemonShutdownReason =
  | { readonly type: 'signal'; readonly signal: NodeJS.Signals }
  | { readonly type: 'uncaughtException'; readonly error: unknown }
  | { readonly type: 'unhandledRejection'; readonly error: unknown }

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runDaemonEntry(): Promise<void> {
  const context = await loadUserConfigContext()
  const i18n = createI18n(detectLocale(context.config))
  const logger = getCliLogger(context.paths)
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
      logger,
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
      await logError(context.paths, ['daemon', 'controlplane'], 'Control plane connection failed', {
        baseUrl: controlPlaneConfig.baseUrl,
        nodeId: controlPlaneConfig.nodeId,
        error: error instanceof Error ? error.message : String(error),
      })
      // controlplane 连接失败时 daemon 继续以本地模式运行
      process.stderr.write('Warning: controlplane connection failed, running in local-only mode\n')
    }
  }

  let shutdownPromise: Promise<void> | null = null

  const shutdown = (reason: DaemonShutdownReason): Promise<void> => {
    if (shutdownPromise !== null) {
      return shutdownPromise
    }

    shutdownPromise = (async () => {
      if (reason.type === 'signal') {
        await logInfo(context.paths, ['daemon'], 'Daemon shutdown signal received', {
          signal: reason.signal,
        })
      }

      if (reason.type === 'uncaughtException') {
        await logError(context.paths, ['daemon'], 'Daemon crashed with uncaught exception', {
          error: formatErrorMessage(reason.error),
        })
      }

      if (reason.type === 'unhandledRejection') {
        await logError(context.paths, ['daemon'], 'Daemon crashed with unhandled rejection', {
          error: formatErrorMessage(reason.error),
        })
      }

      controlPlaneHandle?.connection.stop()
      await server.shutdown()

      await logInfo(context.paths, ['daemon'], 'Daemon exiting', {
        reason: reason.type,
        signal: reason.type === 'signal' ? reason.signal : undefined,
      })

      process.exit(reason.type === 'signal' ? 0 : 1)
    })()

    return shutdownPromise
  }

  process.on('SIGTERM', () => {
    void shutdown({ type: 'signal', signal: 'SIGTERM' })
  })
  process.on('SIGINT', () => {
    void shutdown({ type: 'signal', signal: 'SIGINT' })
  })
  process.on('uncaughtException', (error) => {
    void shutdown({ type: 'uncaughtException', error })
  })
  process.on('unhandledRejection', (error) => {
    void shutdown({ type: 'unhandledRejection', error })
  })
}

// 作为独立子进程被 fork 时，直接执行守护进程逻辑
const _isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (_isMain) {
  await runDaemonEntry()
}
