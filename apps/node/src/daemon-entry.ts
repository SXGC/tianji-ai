import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  type ControlPlaneStatusSnapshot,
  DEFAULT_CONTROL_PLANE_STATUS,
  DaemonServer,
  buildDefaultGraph,
  createAgentSession,
  createUnifiedRuntimeEntry,
  openAgentSession,
} from '@tianji/agent'
import { subscribeEventBusLogger, subscribeOtelAdapter } from '@tianji/observer'
import {
  CausalContext,
  SequenceCounter,
  type SequenceRecoverer,
  createAlsCausalContextProvider,
  createRuntimeEventPipeline,
  resolveAgentModel,
} from '@tianji/runtime'
import { createEventBus } from '@tianji/shared'

import { createForwarder } from './bus/forwarder.js'
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

  // ---- EventBus + Pipeline 装配（node 侧不直连 event_log，阶段 07 后 forwarder 订阅 bus）----
  const bus = createEventBus({
    lagSink: (info) => {
      void logger.observerLogger.warn(['daemon', 'bus'], 'node subscriber lag', { info })
    },
    // I1：把订阅者异常路由到结构化日志，保证错误可观测性
    errorSink: (err) => {
      void logger.observerLogger.error(['daemon', 'bus'], 'daemon bus subscriber error', {
        subscriberName: err.subscriberName,
        subscriptionId: err.subscriptionId,
        eventId: err.envelope.eventId,
        eventType: err.envelope.type,
        error: err.error instanceof Error ? err.error.message : String(err.error),
      })
    },
  })
  const daemonCounter = new SequenceCounter()

  // 每个并发 run 在 als.run() 内持有独立的 { current: CausalContext }，
  // 避免进程级单例在并发请求间互相污染 causation 链。
  const als = new AsyncLocalStorage<{ current: CausalContext }>()
  const contextProvider = createAlsCausalContextProvider(als)

  /**
   * 在 AsyncLocalStorage 上下文中执行 fn，每次调用建立独立的 CausalContext。
   *
   * @param correlationId - 本次请求的关联 ID，贯穿整条因果链
   * @param fn - 在隔离上下文内执行的异步操作
   */
  function enterCorrelation<T>(correlationId: string, fn: () => Promise<T>): Promise<T> {
    return als.run({ current: CausalContext.root(correlationId) }, fn)
  }

  const pipeline = createRuntimeEventPipeline({
    publish: (env) => bus.publish(env),
    counter: daemonCounter,
    contextProvider,
    source: { processKind: 'daemon', processId: process.pid.toString() },
    recoverer: {
      async maxSequence() {
        return null
      },
    } satisfies SequenceRecoverer,
  })

  // ---- 装配 Bus 订阅者 ----
  // Observer Logger：全聚合 trace 级别记录每条 envelope（含 correlationId/causationId/sequence）
  subscribeEventBusLogger(bus, logger.observerLogger)
  // OTel：订阅 Run*/Tool* 事件生成 span（tracing 未初始化时静默跳过）
  subscribeOtelAdapter(bus)
  // Daemon SSE：在 DaemonServer#handleChat 内按请求动态订阅，无需此处装配
  // ACP 内→外：由 DaemonServer 内部通过 session.queryWithGraph 驱动，无需此处装配
  // Stage 07 的 forwarder 将订阅此 bus 并把 envelope 转发到 controlplane。
  // -------------------------

  const built = await buildDefaultGraph(
    { source: 'daemon', input: '', agentId: context.agent.agentName },
    context
  )
  const activeRuns = new Map<string, { abort: () => void }>()
  const entry = createUnifiedRuntimeEntry({
    loadDefaultGraph: async () => built.graph,
    createExecutorRegistry: async () => built.executorFactory,
    runtime: {
      runGraph: async ({ request, graph, executors }) => {
        if (request.sessionId === undefined) {
          throw new Error('Daemon unified entry requires sessionId')
        }
        const sessionId = request.sessionId

        const runtimeOptions = {
          logger: logger.observerLogger,
          emitEvent: (ev: Parameters<typeof pipeline.emitEvent>[0]) => pipeline.emitEvent(ev),
        }
        const session = await enterCorrelation(`daemon-run-${sessionId}`, async () => {
          if (sessionId.startsWith('session_')) {
            const created = await createAgentSession(context, runtimeOptions)
            if (created.sessionId === sessionId) {
              return created
            }
          }

          return openAgentSession(
            context,
            {
              sessionId,
            },
            runtimeOptions
          )
        })
        const events = session.queryWithGraph(graph, {
          initialState: { input: request.input },
          compileOptions: { agentExecutorFactory: executors },
        })
        const iterator = events[Symbol.asyncIterator]()
        const first = await iterator.next()

        if (first.done) {
          throw new Error('Daemon unified entry run ended before emitting any events')
        }

        const firstEvent = first.value
        if (!('runId' in firstEvent) || firstEvent.runId === undefined) {
          throw new Error('Daemon unified entry run did not emit a runId')
        }

        const runId = String(firstEvent.runId)
        activeRuns.set(runId, { abort: () => session.abort() })

        async function* replayEvents(): AsyncIterable<typeof firstEvent> {
          try {
            yield firstEvent
            while (true) {
              const next = await iterator.next()
              if (next.done) {
                return
              }
              yield next.value
            }
          } finally {
            activeRuns.delete(runId)
          }
        }

        return {
          sessionId: session.sessionId,
          runId: firstEvent.runId,
          events: replayEvents(),
        }
      },
      resumeGraph: async () => {
        throw new Error('daemon unified entry resume is not implemented yet')
      },
      cancelRun: async ({ runId }) => {
        const active = activeRuns.get(String(runId))
        if (active === undefined) {
          throw new Error(`Daemon unified entry cannot cancel unknown runId: ${String(runId)}`)
        }
        active.abort()
      },
      streamRun: () => {
        throw new Error('daemon unified entry stream is not implemented yet')
      },
    },
  })
  await logDebug(
    context.paths,
    ['daemon', 'controlplane'],
    'Prepared native runtime dependencies',
    {
      hasDefaultGraph: built.graph !== undefined,
      defaultGraphId: built.graph.id,
      hasExecutorFactory: built.executorFactory !== undefined,
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
    entry,
    bus,
    getControlPlaneStatus: () => controlPlaneStatus,
    paths: {
      daemonPortPath: context.paths.daemonPortPath,
      daemonPidPath: context.paths.daemonPidPath,
    },
    enterCorrelation,
  })
  await server.listen(0)
  await logInfo(context.paths, ['daemon'], 'Daemon server listening', {
    port: server.port,
  })

  process.stdout.write(`${i18n.t('daemon.listening', { port: server.port })}\n`)

  // 如果用户配置中包含 controlplane 配置，则启动 controlplane 连接
  const controlPlaneConfig = readStoredControlPlaneConfig(context.config)
  let controlPlaneHandle: ControlPlaneRuntimeHandle | null = null
  // forwarder 在有 cp 配置时装配，持有引用以便 shutdown 时 dispose
  let forwarderDispose: (() => Promise<void>) | null = null
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
    let nodePipeline: ReturnType<typeof createRuntimeEventPipeline> | null = null
    const runtime = createControlPlaneRuntime({
      ...controlPlaneConfig,
      agentConfigs: context.config.agents?.items ?? {},
      nativeAgentContext: context,
      defaultGraph: built.graph,
      executorFactory: built.executorFactory,
      agentList: deriveControlPlaneAgentList(context.config, controlPlaneConfig.version),
      logger,
      observerLogger: logger.observerLogger,
      enterCorrelation,
      emitTaskEvent: (ev) => {
        if (nodePipeline === null) {
          throw new Error('Node task event pipeline not initialized')
        }
        return nodePipeline.emitEvent(ev)
      },
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
      const nodeCounter = new SequenceCounter()
      nodePipeline = createRuntimeEventPipeline({
        publish: (env) => bus.publish(env),
        counter: nodeCounter,
        contextProvider,
        source: {
          processKind: 'node',
          processId: process.pid.toString(),
          nodeId: controlPlaneConfig.nodeId,
        },
        recoverer: {
          async maxSequence(aggregateType, aggregateId) {
            const client = runtime.connection.client
            if (client === undefined) {
              throw new Error('Control plane client unavailable for max sequence recovery')
            }
            return client.maxSequence(aggregateType, aggregateId)
          },
        },
      })
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

      // ---- 装配 forwarder（订阅在 als.run() 外，符合 Stage 06 review 约束）----
      // 从 connection.client 获取 postDomainEvents，当 client 不可用时直接抛出（let it crash）
      const cpClient = runtime.connection.client
      if (cpClient !== undefined) {
        const forwarder = createForwarder({
          bus,
          post: async ({ events }) => {
            const ndjson = events.map((e) => JSON.stringify(e)).join('\n')
            await cpClient.postDomainEvents(ndjson)
          },
          maxItems: 500,
          flushIntervalMs: 50,
          logger: logger.observerLogger,
          // 动态获取当前执行任务的 taskId，null 时 flush 跳过
          getCurrentTaskId: () => runtime.taskExecutor.currentTaskId,
        })
        forwarderDispose = () => forwarder.dispose()
        await logDebug(context.paths, ['daemon', 'controlplane'], 'Forwarder subscribed to bus', {
          maxItems: 500,
          flushIntervalMs: 50,
        })
      }
      // -------------------------------------------------------------------------
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
      // forwarder final-flush：确保在途 envelope 在进程退出前发送到 cp
      if (forwarderDispose !== null) {
        await forwarderDispose()
      }
      await bus.close()
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
