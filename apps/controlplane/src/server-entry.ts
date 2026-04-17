import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { serve } from '@hono/node-server'
import {
  type ObserverLogger,
  createJsonlFileSink,
  createObserverLogger,
  createStderrSink,
  createStdoutSink,
  errorToLogData,
  subscribeEventBusLogger,
  subscribeOtelAdapter,
} from '@tianji/observer'
import {
  CausalContext,
  SequenceCounter,
  createAlsCausalContextProvider,
  createRuntimeEventPipeline,
} from '@tianji/runtime'
import { createEventBus } from '@tianji/shared'

import { createApp } from './app.js'
import { createDatabase } from './db/index.js'
import { createEventLogRecoverer } from './storage/event-log-recoverer.js'
import { SqliteEventLogStore } from './storage/event-log-sqlite.js'
import { subscribeEventLog } from './storage/event-log-subscriber.js'

const SCOPE_SERVER = ['controlplane', 'server'] as const
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

export interface ControlPlaneServerHandle {
  readonly shutdown: () => Promise<void>
  readonly logger: ObserverLogger
}

/**
 * 启动 controlplane。返回优雅关闭钩子，便于 crash handler 与测试注入。
 */
export function startControlPlaneServer(): ControlPlaneServerHandle {
  const port = Number(process.env.TIANJI_CP_PORT ?? 3000)
  const host = process.env.TIANJI_CP_HOST ?? '0.0.0.0'
  const dataDir =
    process.env.TIANJI_CP_DATA_DIR ?? `${process.env.HOME}/.config/tianji-ai/controlplane`
  const dbPath = `${dataDir}/controlplane.db`
  const logFilePath = join(homedir(), '.config', 'tianji-ai', 'logs', 'tianji.log')

  mkdirSync(dataDir, { recursive: true })
  mkdirSync(join(homedir(), '.config', 'tianji-ai', 'logs'), { recursive: true })

  const db = createDatabase(dbPath)
  const logger = createObserverLogger({
    sinks: [
      createJsonlFileSink({ filePath: logFilePath }),
      createStdoutSink({ pretty: true }),
      createStderrSink({ minLevel: 'warn' }),
    ],
  })

  const store = new SqliteEventLogStore(db.raw)
  const recoverer = createEventLogRecoverer(store)
  const bus = createEventBus({
    lagSink: (info) => {
      void logger.warn(SCOPE_SERVER, 'cp subscriber lag', { info })
    },
    errorSink: (err) => {
      void logger.error(SCOPE_SERVER, 'cp bus subscriber error', {
        subscriberName: err.subscriberName,
        subscriptionId: err.subscriptionId,
        eventId: err.envelope.eventId,
        eventType: err.envelope.type,
        error: errorToLogData(err.error),
      })
    },
  })
  const counter = new SequenceCounter()

  const als = new AsyncLocalStorage<{ current: CausalContext }>()
  const contextProvider = createAlsCausalContextProvider(als)

  function enterCorrelation<T>(correlationId: string, fn: () => Promise<T>): Promise<T> {
    return als.run({ current: CausalContext.root(correlationId) }, fn)
  }

  const pipeline = createRuntimeEventPipeline({
    publish: (env) => bus.publish(env),
    counter,
    contextProvider,
    source: { processKind: 'cp', processId: process.pid.toString() },
    recoverer,
  })
  const eventLogHandle = subscribeEventLog(bus, store, {
    logger,
    errorSink: (err) => {
      void logger.error(SCOPE_SERVER, 'cp event-log-subscriber error', {
        subscriberName: err.subscriberName,
        subscriptionId: err.subscriptionId,
        eventId: err.envelope.eventId,
        eventType: err.envelope.type,
        error: errorToLogData(err.error),
      })
    },
  })

  subscribeEventBusLogger(bus, logger)
  subscribeOtelAdapter(bus)

  const { app, monitor } = createApp(db, logger, {
    emitEvent: (ev) => pipeline.emitEvent(ev),
    enterCorrelation,
    bus,
  })
  monitor.start()

  const server = serve({ fetch: app.fetch, port, hostname: host })

  void logger.info(SCOPE_SERVER, 'Control plane started', { port, host, dbPath })

  const shutdown = async (): Promise<void> => {
    monitor.stop()
    await bus.close()
    await eventLogHandle.close()
    db.close()
    server.close()
  }

  return { shutdown, logger }
}

/** 给崩溃 handler 的依赖注入形状。便于测试。 */
export interface CrashHandlerOptions {
  readonly logger: ObserverLogger
  readonly shutdown: () => Promise<void>
  readonly shutdownTimeoutMs?: number
  readonly exit?: (code: number) => void
}

export interface CrashHandlers {
  readonly onUncaughtException: (err: unknown) => Promise<void>
  readonly onUnhandledRejection: (err: unknown) => Promise<void>
  readonly onSignal: (signal: NodeJS.Signals) => Promise<void>
  /** 测试用：等待所有已入队的异步日志落盘。 */
  readonly flush: () => Promise<void>
}

/** 构建进程级崩溃/退出 handler。不直接注册到 process 上，便于注入与测试。 */
export function createCrashHandlers(options: CrashHandlerOptions): CrashHandlers {
  const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const exit = options.exit ?? ((code) => process.exit(code))
  const pending = new Set<Promise<unknown>>()

  const track = <T>(p: Promise<T>): Promise<T> => {
    pending.add(p)
    void p.finally(() => pending.delete(p))
    return p
  }

  const runShutdownWithTimeout = async (): Promise<void> => {
    await Promise.race([
      options.shutdown().catch((shutdownErr) => {
        void options.logger.error(SCOPE_SERVER, 'Shutdown step threw', {
          error: errorToLogData(shutdownErr),
        })
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => resolve(), timeoutMs)
      }),
    ])
  }

  const onUncaughtException = async (err: unknown): Promise<void> => {
    await track(
      options.logger.fatal(SCOPE_SERVER, 'Control plane crashed with uncaught exception', {
        error: errorToLogData(err),
      })
    )
    await runShutdownWithTimeout()
    exit(1)
  }

  const onUnhandledRejection = async (err: unknown): Promise<void> => {
    await track(
      options.logger.error(SCOPE_SERVER, 'Control plane caught unhandled rejection', {
        error: errorToLogData(err),
      })
    )
  }

  const onSignal = async (signal: NodeJS.Signals): Promise<void> => {
    await track(
      options.logger.info(SCOPE_SERVER, 'Control plane shutdown signal received', { signal })
    )
    await runShutdownWithTimeout()
    exit(0)
  }

  const flush = async (): Promise<void> => {
    await Promise.all([...pending])
  }

  return { onUncaughtException, onUnhandledRejection, onSignal, flush }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  try {
    const handle = startControlPlaneServer()
    const handlers = createCrashHandlers({
      logger: handle.logger,
      shutdown: handle.shutdown,
    })
    process.on('SIGTERM', (signal) => {
      void handlers.onSignal(signal)
    })
    process.on('SIGINT', (signal) => {
      void handlers.onSignal(signal)
    })
    process.on('uncaughtException', (err) => {
      void handlers.onUncaughtException(err)
    })
    process.on('unhandledRejection', (err) => {
      void handlers.onUnhandledRejection(err)
    })
  } catch (error: unknown) {
    process.stderr.write(
      `[controlplane] Fatal startup error: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    )
    if (error instanceof Error && error.stack !== undefined) {
      process.stderr.write(`${error.stack}\n`)
    }
    process.exit(1)
  }
}
