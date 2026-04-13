import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  type ControlPlaneStatusSnapshot,
  DEFAULT_CONTROL_PLANE_STATUS,
  DaemonServer,
  createAgentSession,
  createDeepagentsExecutorFactory,
  loadDefaultOrchestrationGraph,
} from '@tianji/agent'
import { resolveAgentModel } from '@tianji/runtime'

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

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runDaemonEntry(): Promise<void> {
  // 开发环境中 daemon 作为 detached 进程，PATH 不含 pnpm 注入的本地 .bin 目录。
  // 若本地 node_modules/.bin/tianji-agent 存在（workspace 链接），则追加到 PATH。
  // 生产环境全局安装时该路径不存在，条件不成立，不做修改。
  const localBin = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin')
  if (existsSync(join(localBin, 'tianji-agent'))) {
    process.env.PATH = `${localBin}:${process.env.PATH ?? ''}`
  }

  const context = await loadUserConfigContext()
  const i18n = createI18n(detectLocale(context.config))
  const logger = getCliLogger(context.paths)
  const session = await createAgentSession(context, {
    logger: logger.observerLogger,
  })
  const defaultGraph = await loadDefaultOrchestrationGraph({
    configDir: context.paths.configDir,
    agentConfigs: context.config.agents?.items ?? {},
  })
  const executorFactory = createDeepagentsExecutorFactory({
    // 走 runtime 的 resolveAgentModel：当 provider 配置了自定义 baseUrl 时，
    // 预先实例化 ChatOpenAI，避免 deepagents 内部的 initChatModel 无法识别 provider。
    resolveModel: (modelRef) => resolveAgentModel(modelRef, context.config.providers),
    observer: logger.observerLogger,
  })
  await logDebug(
    context.paths,
    ['daemon', 'controlplane'],
    'Prepared native runtime dependencies',
    {
      hasDefaultGraph: defaultGraph !== undefined,
      defaultGraphId: defaultGraph.id,
      hasExecutorFactory: executorFactory !== undefined,
    }
  )
  let controlPlaneStatus: ControlPlaneStatusSnapshot = DEFAULT_CONTROL_PLANE_STATUS

  const updateControlPlaneStatus = (
    patch: Partial<ControlPlaneStatusSnapshot>
  ): ControlPlaneStatusSnapshot => {
    controlPlaneStatus = {
      ...controlPlaneStatus,
      ...patch,
    }
    return controlPlaneStatus
  }

  const server = new DaemonServer({
    session,
    defaultGraph,
    executorFactory,
    getControlPlaneStatus: () => controlPlaneStatus,
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
    updateControlPlaneStatus({
      enabled: true,
      status: 'connecting',
      baseUrl: controlPlaneConfig.baseUrl,
      lastSuccessAt: null,
      lastError: null,
    })
    await logDebug(context.paths, ['daemon', 'controlplane'], 'Loaded control plane config', {
      baseUrl: controlPlaneConfig.baseUrl,
      nodeId: controlPlaneConfig.nodeId,
    })
    const runtime = createControlPlaneRuntime({
      ...controlPlaneConfig,
      agentConfigs: context.config.agents?.items ?? {},
      nativeAgentContext: context,
      defaultGraph,
      executorFactory,
      agentList: deriveControlPlaneAgentList(context.config, controlPlaneConfig.version),
      logger,
      observerLogger: logger.observerLogger,
      onConnectionStateChange: (event) => {
        if (event.status === 'connecting') {
          updateControlPlaneStatus({
            enabled: true,
            status: 'connecting',
            baseUrl: controlPlaneConfig.baseUrl,
            lastError: null,
          })
          return
        }

        if (event.status === 'connected' || event.status === 'heartbeat_succeeded') {
          updateControlPlaneStatus({
            enabled: true,
            status: 'connected',
            baseUrl: controlPlaneConfig.baseUrl,
            lastSuccessAt: Date.now(),
            lastError: null,
          })
          return
        }

        updateControlPlaneStatus({
          enabled: true,
          status: 'degraded',
          baseUrl: controlPlaneConfig.baseUrl,
          lastError: event.error ?? 'controlplane unavailable',
        })
      },
    })
    try {
      await runtime.connection.start()
      controlPlaneHandle = runtime
      updateControlPlaneStatus({
        enabled: true,
        status: 'connected',
        baseUrl: controlPlaneConfig.baseUrl,
        lastSuccessAt: Date.now(),
        lastError: null,
      })
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
      updateControlPlaneStatus({
        enabled: true,
        status: 'degraded',
        baseUrl: controlPlaneConfig.baseUrl,
        lastError: error instanceof Error ? error.message : String(error),
      })
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

      controlPlaneHandle?.connection.stop()
      await server.shutdown()

      await logInfo(context.paths, ['daemon'], 'Daemon exiting', {
        reason: reason.type,
        signal: reason.type === 'signal' ? reason.signal : undefined,
      })

      await server.deleteStateFiles()
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
    void logError(context.paths, ['daemon'], 'Daemon caught unhandled rejection', {
      error: formatErrorMessage(error),
    })
  })
}

// 作为独立子进程被 fork 时，直接执行守护进程逻辑
const _isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (_isMain) {
  try {
    await runDaemonEntry()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined
    process.stderr.write(`[daemon] Fatal startup error: ${message}\n`)
    if (stack) {
      process.stderr.write(`${stack}\n`)
    }
    try {
      const { getUserConfigPaths } = await import('./config.js')
      const paths = getUserConfigPaths()
      await logError(paths, ['daemon'], 'Fatal startup error', {
        error: message,
        stack,
      })
    } catch {
      // 日志写入失败时不再尝试
    }
    process.exit(1)
  }
}
