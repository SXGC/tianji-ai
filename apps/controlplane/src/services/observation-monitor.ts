import type { ObserverLogger } from '@tianji/observer'

import type { ControlPlaneDb } from '../db/index.js'
import { HEARTBEAT_TIMEOUT_MS } from '../routes/node-heartbeat.js'

const SCOPE_MONITOR = ['controlplane', 'monitor'] as const

/**
 * 监控离线 node，并把活动任务转为 observation_lost。
 */
export class ObservationMonitor {
  readonly #db: ControlPlaneDb
  readonly #logger: ObserverLogger
  #timer: ReturnType<typeof setInterval> | null = null

  /**
   * @param db - controlplane 数据库实例
   * @param logger - 结构化日志实例
   */
  constructor(db: ControlPlaneDb, logger: ObserverLogger) {
    this.#db = db
    this.#logger = logger
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
      }

      const taskChange = this.#db.raw
        .prepare(
          `UPDATE tasks SET status = 'observation_lost', failure_reason = 'observation_lost', updated_at = ?
           WHERE node_id = ? AND status IN ('running', 'waiting')`
        )
        .run(now, nodeId)

      if (taskChange.changes > 0) {
        void this.#logger.warn(SCOPE_MONITOR, 'Tasks marked as observation_lost', {
          nodeId,
          taskCount: taskChange.changes,
        })
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
