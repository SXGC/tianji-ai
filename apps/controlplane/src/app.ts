import { Hono } from 'hono'

import type { ControlPlaneDb } from './db/index.js'
import { createCommandPollRoute } from './routes/command-poll.js'
import { createNodeHeartbeatRoute } from './routes/node-heartbeat.js'
import { createNodeRegisterRoute } from './routes/node-register.js'
import { createTaskEventsRoute } from './routes/task-events.js'
import { createTaskStreamRoute } from './routes/task-stream.js'
import { createUiNodesRoute } from './routes/ui-nodes.js'
import { createUiSessionsRoute } from './routes/ui-sessions.js'
import { createUiTaskEventsRoute } from './routes/ui-task-events.js'
import { createUiTasksRoute } from './routes/ui-tasks.js'
import { createWebUiRoute } from './routes/web-ui.js'
import { ObservationMonitor } from './services/observation-monitor.js'

export interface ControlPlaneApp {
  readonly app: Hono
  readonly monitor: ObservationMonitor
}

/**
 * 创建 controlplane HTTP 应用。
 */
export function createApp(db: ControlPlaneDb): ControlPlaneApp {
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))

  app.route('/', createNodeRegisterRoute(db))
  app.route('/', createNodeHeartbeatRoute(db))
  app.route('/', createCommandPollRoute(db))
  app.route('/', createTaskEventsRoute(db))

  app.route('/', createUiNodesRoute(db))
  app.route('/', createUiTasksRoute(db))
  app.route('/', createUiSessionsRoute(db))
  app.route('/', createUiTaskEventsRoute(db))
  app.route('/', createTaskStreamRoute(db))
  app.route('/', createWebUiRoute())

  return {
    app,
    monitor: new ObservationMonitor(db),
  }
}
