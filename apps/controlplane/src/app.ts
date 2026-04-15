import type { ObserverLogger } from '@tianji/observer'
import type { DomainEvent, EventBus } from '@tianji/shared'
import { Hono } from 'hono'

import type { ControlPlaneDb } from './db/index.js'
import { createCommandPollRoute } from './routes/command-poll.js'
import { createCopilotRoute } from './routes/copilot.js'
import { createEventsRoute } from './routes/events.js'
import { createNodeHeartbeatRoute } from './routes/node-heartbeat.js'
import { createNodeRegisterRoute } from './routes/node-register.js'
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
  /** 可选：进程内 EventBus 实例，用于 AG-UI 适配器订阅领域事件。 */
  readonly bus?: EventBus
  /**
   * 可选：在每个请求前建立独立的因果链上下文。
   * 由装配层注入（例如 AsyncLocalStorage.run 包裹），确保并发请求间因果链不互相污染。
   * 若未提供，路由 handler 直接执行（不建立独立上下文）。
   *
   * @param correlationId - 本次请求的关联 ID（由 x-correlation-id header 或 UUID 生成）
   * @param fn - 在独立上下文内执行的 handler 体
   */
  readonly enterCorrelation?: <T>(correlationId: string, fn: () => Promise<T>) => Promise<T>
}

/**
 * 创建 controlplane HTTP 应用。
 *
 * @param db - controlplane 数据库实例
 * @param logger - 结构化日志实例，传递给需要日志的子模块
 * @param options - 可选装配选项（emitEvent 回调、enterCorrelation 包裹器）
 */
export function createApp(
  db: ControlPlaneDb,
  logger: ObserverLogger,
  options: CreateAppOptions = {}
): ControlPlaneApp {
  const { emitEvent, enterCorrelation, bus } = options
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))

  // 为每个 API 请求建立独立的因果链上下文（若 enterCorrelation 已注入）。
  // 从 x-correlation-id header 读取，或生成新 UUID 作为 correlationId。
  if (enterCorrelation !== undefined) {
    app.use('/api/*', async (c, next) => {
      const correlationId = c.req.header('x-correlation-id') ?? crypto.randomUUID()
      await enterCorrelation(correlationId, next)
    })
  }

  app.route('/', createNodeRegisterRoute(db, logger, emitEvent))
  app.route('/', createNodeHeartbeatRoute(db, logger))
  app.route('/', createCommandPollRoute(db, logger))
  // bus 由 Task 5 统一注入；未注入时跳过路由注册（等同于 404），
  // 避免在无 bus 的测试环境中启动时 throw。
  if (bus !== undefined) {
    app.route('/', createEventsRoute({ db, logger, bus }))
  }

  app.route('/', createUiNodesRoute(db))
  app.route('/', createCopilotRoute(db, bus))
  app.route('/', createWebUiRoute())

  return {
    app,
    monitor: new ObservationMonitor(db, logger, emitEvent, enterCorrelation),
  }
}
