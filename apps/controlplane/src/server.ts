import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { serve } from '@hono/node-server'
import { createJsonlFileSink, createObserverLogger, createStdoutSink } from '@tianji/observer'

import { createApp } from './app.js'
import { createDatabase } from './db/index.js'

const port = Number(process.env.TIANJI_CP_PORT ?? 3000)
const host = process.env.TIANJI_CP_HOST ?? '0.0.0.0'
const dataDir =
  process.env.TIANJI_CP_DATA_DIR ?? `${process.env.HOME}/.config/tianji-ai/controlplane`
const dbPath = `${dataDir}/controlplane.db`
const logFilePath = join(homedir(), '.config', 'tianji-ai', 'logs', 'tianji.log')

mkdirSync(dataDir, { recursive: true })

const db = createDatabase(dbPath)
const logger = createObserverLogger({
  sinks: [createJsonlFileSink({ filePath: logFilePath }), createStdoutSink({ pretty: true })],
})

const SCOPE_SERVER = ['controlplane', 'server'] as const

const { app, monitor } = createApp(db, logger)
monitor.start()

const server = serve({ fetch: app.fetch, port, hostname: host })

void logger.info(SCOPE_SERVER, 'Control plane started', { port, host, dbPath })

const shutdown = () => {
  monitor.stop()
  db.close()
  server.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
