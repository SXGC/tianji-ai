import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { serve } from '@hono/node-server'
import {
  createJsonlFileSink,
  createObserverLogger,
  createStdoutSink,
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
  sinks: [createJsonlFileSink({ filePath: logFilePath }), createStdoutSink({ pretty: true })],
})

const SCOPE_SERVER = ['controlplane', 'server'] as const

// ---- EventBus + EventLogStore + Pipeline 装配 ----
const store = new SqliteEventLogStore(db.raw)
const recoverer = createEventLogRecoverer(store)
const bus = createEventBus({
  lagSink: (info) => {
    void logger.warn(SCOPE_SERVER, 'cp subscriber lag', { info })
  },
  // I1：把订阅者异常路由到结构化日志，保证错误可观测性
  errorSink: (err) => {
    void logger.error(SCOPE_SERVER, 'cp bus subscriber error', {
      subscriberName: err.subscriberName,
      subscriptionId: err.subscriptionId,
      eventId: err.envelope.eventId,
      eventType: err.envelope.type,
      error: err.error instanceof Error ? err.error.message : String(err.error),
    })
  },
})
const counter = new SequenceCounter()

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
export function enterCorrelation<T>(correlationId: string, fn: () => Promise<T>): Promise<T> {
  return als.run({ current: CausalContext.root(correlationId) }, fn)
}

const pipeline = createRuntimeEventPipeline({
  publish: (env) => bus.publish(env),
  counter,
  contextProvider,
  source: { processKind: 'cp', processId: process.pid.toString() },
  recoverer,
})
// I2：传入 errorSink，把 flush 错误和 push 错误统一路由到总线 errorSink
const eventLogHandle = subscribeEventLog(bus, store, {
  logger,
  errorSink: (err) => {
    void logger.error(SCOPE_SERVER, 'cp event-log-subscriber error', {
      subscriberName: err.subscriberName,
      subscriptionId: err.subscriptionId,
      eventId: err.envelope.eventId,
      eventType: err.envelope.type,
      error: err.error instanceof Error ? err.error.message : String(err.error),
    })
  },
})

// ---- 装配 Bus 订阅者 ----
// Observer Logger：全聚合 trace 级别记录每条 envelope（含 correlationId/causationId/sequence）
subscribeEventBusLogger(bus, logger)
// OTel：订阅 Run*/Tool* 事件生成 span（tracing 未初始化时静默跳过）
subscribeOtelAdapter(bus)
// AG-UI：由 TianjiAgent 在每次 copilot 请求中通过 bus 参数动态订阅，无需此处装配
// -------------------------
// ------------------------------------------------

const { app, monitor } = createApp(db, logger, {
  emitEvent: (ev) => pipeline.emitEvent(ev),
  enterCorrelation,
})
monitor.start()

const server = serve({ fetch: app.fetch, port, hostname: host })

void logger.info(SCOPE_SERVER, 'Control plane started', { port, host, dbPath })

const shutdown = () => {
  monitor.stop()
  // TODO(Stage 06)：bus 当前无 close/drain 方法。Stage 06 引入 AsyncLocalStorage 时一并添加
  // bus.close()，确保所有在途 handler 完成后再关闭 eventLogHandle。
  void eventLogHandle.close().then(() => {
    db.close()
    server.close()
    process.exit(0)
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
