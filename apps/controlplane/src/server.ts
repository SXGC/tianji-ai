import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { serve } from '@hono/node-server'
import { createJsonlFileSink, createObserverLogger, createStdoutSink } from '@tianji/observer'
import { CausalContext, SequenceCounter, createRuntimeEventPipeline } from '@tianji/runtime'
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
// TODO(Stage 06, Task 0)：contextRef 是进程级共享单例，并发 run 会互相污染 causation 链。
// 必须在 Stage 06 用 AsyncLocalStorage 替换，使每次请求持有独立的 CausalContext。
const contextRef = { current: CausalContext.root(crypto.randomUUID()) }
const pipeline = createRuntimeEventPipeline({
  publish: (env) => bus.publish(env),
  counter,
  contextRef,
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
// ------------------------------------------------

const { app, monitor } = createApp(db, logger, {
  emitEvent: (ev) => pipeline.emitEvent(ev),
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
