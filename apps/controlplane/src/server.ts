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
})
const counter = new SequenceCounter()
const contextRef = { current: CausalContext.root(crypto.randomUUID()) }
const pipeline = createRuntimeEventPipeline({
  publish: (env) => bus.publish(env),
  counter,
  contextRef,
  source: { processKind: 'cp', processId: process.pid.toString() },
  recoverer,
})
const eventLogHandle = subscribeEventLog(bus, store, { logger })
// ------------------------------------------------

const { app, monitor } = createApp(db, logger, {
  emitEvent: (ev) => pipeline.emitEvent(ev),
})
monitor.start()

const server = serve({ fetch: app.fetch, port, hostname: host })

void logger.info(SCOPE_SERVER, 'Control plane started', { port, host, dbPath })

const shutdown = () => {
  monitor.stop()
  void eventLogHandle.close().then(() => {
    db.close()
    server.close()
    process.exit(0)
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
