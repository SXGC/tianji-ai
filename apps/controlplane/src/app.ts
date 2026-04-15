import type { ObserverLogger } from '@tianji/observer'
import type { DomainEvent } from '@tianji/shared'
import { Hono } from 'hono'

import type { ControlPlaneDb } from './db/index.js'
import { createCommandPollRoute } from './routes/command-poll.js'
import { createCopilotRoute } from './routes/copilot.js'
import { createNodeHeartbeatRoute } from './routes/node-heartbeat.js'
import { createNodeRegisterRoute } from './routes/node-register.js'
import { createTaskEventsRoute } from './routes/task-events.js'
import { createUiNodesRoute } from './routes/ui-nodes.js'
import { createWebUiRoute } from './routes/web-ui.js'
import { ObservationMonitor } from './services/observation-monitor.js'

export interface ControlPlaneApp {
  readonly app: Hono
  readonly monitor: ObservationMonitor
}

export interface CreateAppOptions {
  /** 可选：DomainEvent 发射回调，由装配层注入，用于把 Node/Task 生命周期事件发到 EventBus。 */
  readonly emitEvent?: (ev: DomainEvent) => void | Promise<void>
}

/**
 * 创建 controlplane HTTP 应用。
 *
 * @param db - controlplane 数据库实例
 * @param logger - 结构化日志实例，传递给需要日志的子模块
 * @param options - 可选装配选项（emitEvent 回调）
 */
export function createApp(
  db: ControlPlaneDb,
  logger: ObserverLogger,
  options: CreateAppOptions = {}
): ControlPlaneApp {
  const { emitEvent } = options
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))

  app.route('/', createNodeRegisterRoute(db, logger, emitEvent))
  app.route('/', createNodeHeartbeatRoute(db, logger))
  app.route('/', createCommandPollRoute(db, logger))
  app.route('/', createTaskEventsRoute(db, logger))

  app.route('/', createUiNodesRoute(db))
  app.route('/', createCopilotRoute(db))
  app.route('/', createWebUiRoute())

  return {
    app,
    monitor: new ObservationMonitor(db, logger, emitEvent),
  }
}
