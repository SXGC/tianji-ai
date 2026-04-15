import type { ObserverLogger } from '@tianji/observer'
import type { DomainEvent } from '@tianji/shared'

import type { ControlPlaneDb } from '../db/index.js'
import { HEARTBEAT_TIMEOUT_MS } from '../routes/node-heartbeat.js'

const SCOPE_MONITOR = ['controlplane', 'monitor'] as const

/** 同步上下文中发射事件并捕获错误，防止 fire-and-forget 丢失异常。 */
function emitSafe(
  emitEvent: ((ev: DomainEvent) => void | Promise<void>) | undefined,
  event: DomainEvent,
  logger: ObserverLogger
): void {
  const result = emitEvent?.(event)
  if (result instanceof Promise) {
    result.catch((err: unknown) => {
      void logger.error(SCOPE_MONITOR, 'emitEvent failed', {
        eventType: event.type,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
}

/**
 * 监控离线 node，并把活动任务转为 observation_lost。
 */
export class ObservationMonitor {
  readonly #db: ControlPlaneDb
  readonly #logger: ObserverLogger
  readonly #emitEvent: ((ev: DomainEvent) => void | Promise<void>) | undefined
  #timer: ReturnType<typeof setInterval> | null = null

  /**
   * @param db - controlplane 数据库实例
   * @param logger - 结构化日志实例
   * @param emitEvent - 可选：DomainEvent 发射回调，用于发射 Node/Task 生命周期事件
   */
  constructor(
    db: ControlPlaneDb,
    logger: ObserverLogger,
    emitEvent?: (ev: DomainEvent) => void | Promise<void>
  ) {
    this.#db = db
    this.#logger = logger
    this.#emitEvent = emitEvent
  }

  /** 启动周期检查。 */
  start(intervalMs = 30_000): void {
    this.#timer = setInterval(() => this.checkOfflineNodes(), intervalMs)
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }

  /**
   * 将心跳超时 node 上的 running/waiting 任务转为 observation_lost。
   * checkOfflineNodes 由 setInterval 同步调用，logger 调用使用 void 触发。
   */
  checkOfflineNodes(): void {
    const now = Date.now()
    const threshold = now - HEARTBEAT_TIMEOUT_MS
    const offlineNodes = this.#db.raw
      .prepare(
        `SELECT node_id FROM nodes
         WHERE last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?`
      )
      .all(threshold) as Array<{ node_id: string }>

    for (const { node_id: nodeId } of offlineNodes) {
      const statusChange = this.#db.raw
        .prepare('UPDATE nodes SET status = ? WHERE node_id = ? AND status = ?')
        .run('offline', nodeId, 'online')

      if (statusChange.changes > 0) {
        void this.#logger.warn(SCOPE_MONITOR, 'Node marked offline', { nodeId })
        emitSafe(
          this.#emitEvent,
          {
            type: 'NodeMarkedOffline',
            nodeId,
            reason: 'heartbeat-timeout',
            timestamp: now,
          },
          this.#logger
        )
      }

      // 先查出受影响的 task_id，再批量更新状态，以便逐一发射 TaskObservationLost 事件。
      const affectedTasks = this.#db.raw
        .prepare(
          `SELECT task_id, updated_at FROM tasks
           WHERE node_id = ? AND status IN ('running', 'waiting')`
        )
        .all(nodeId) as Array<{ task_id: string; updated_at: number }>

      if (affectedTasks.length > 0) {
        this.#db.raw
          .prepare(
            `UPDATE tasks SET status = 'observation_lost', failure_reason = 'observation_lost', updated_at = ?
             WHERE node_id = ? AND status IN ('running', 'waiting')`
          )
          .run(now, nodeId)

        void this.#logger.warn(SCOPE_MONITOR, 'Tasks marked as observation_lost', {
          nodeId,
          taskCount: affectedTasks.length,
        })

        for (const { task_id: taskId, updated_at: lastUpdatedAt } of affectedTasks) {
          emitSafe(
            this.#emitEvent,
            {
              type: 'TaskObservationLost',
              taskId,
              lastObservedAt: new Date(lastUpdatedAt).toISOString(),
              timestamp: now,
            },
            this.#logger
          )
        }
      }

      this.#db.raw
        .prepare(
          `UPDATE commands SET state = 'observation_lost'
           WHERE node_id = ? AND state IN ('leased', 'running')`
        )
        .run(nodeId)
    }
  }
}
