import { mkdirSync } from 'node:fs'

import { serve } from '@hono/node-server'

import { createApp } from './app.js'
import { createDatabase } from './db/index.js'

const port = Number(process.env.TIANJI_CP_PORT ?? 3000)
const host = process.env.TIANJI_CP_HOST ?? '0.0.0.0'
const dataDir =
  process.env.TIANJI_CP_DATA_DIR ?? `${process.env.HOME}/.config/tianji-ai/controlplane`
const dbPath = `${dataDir}/controlplane.db`

mkdirSync(dataDir, { recursive: true })

const db = createDatabase(dbPath)
const { app, monitor } = createApp(db)
monitor.start()

const server = serve({ fetch: app.fetch, port, hostname: host })

console.log(`Control Plane listening on port ${port}`)
console.log(`Database: ${dbPath}`)

const shutdown = () => {
  monitor.stop()
  db.close()
  server.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
