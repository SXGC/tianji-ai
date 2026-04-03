import type { ControlPlaneDb } from '../db/index.js'

export interface StoredTaskEvent {
  taskId: string
  sequence: number
  kind: string
  payload: string
  receivedAt: number
}

export interface EventStoreOptions {
  /** 单任务事件 payload 总字节上限，默认 10 MB。 */
  readonly maxPayloadBytes?: number
}

/**
 * task 事件存储与读取。
 */
export class EventStore {
  readonly #db: ControlPlaneDb
  readonly #maxPayloadBytes: number

  constructor(db: ControlPlaneDb, options?: EventStoreOptions) {
    this.#db = db
    this.#maxPayloadBytes = options?.maxPayloadBytes ?? 10 * 1024 * 1024
  }

  /**
   * 使用 INSERT OR IGNORE 按 taskId + sequence 去重写入。
   */
  insertEvent(taskId: string, sequence: number, kind: string, payload: string): void {
    const now = Date.now()

    this.#db.raw
      .prepare(
        `INSERT OR IGNORE INTO task_events (task_id, sequence, kind, payload, received_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(taskId, sequence, kind, payload, now)

    this.truncateIfNeeded(taskId)
  }

  /**
   * 读取 sequence 大于 afterSequence 的事件。
   */
  getEvents(taskId: string, afterSequence: number, limit: number): StoredTaskEvent[] {
    return this.#db.raw
      .prepare(
        `SELECT task_id AS taskId, sequence, kind, payload, received_at AS receivedAt
         FROM task_events
         WHERE task_id = ? AND sequence > ?
         ORDER BY sequence ASC
         LIMIT ?`
      )
      .all(taskId, afterSequence, limit) as StoredTaskEvent[]
  }

  /**
   * 截断超限的 agent 事件，始终保留 lifecycle 事件。
   */
  truncateIfNeeded(taskId: string): void {
    const sizeRow = this.#db.raw
      .prepare('SELECT SUM(LENGTH(payload)) as totalSize FROM task_events WHERE task_id = ?')
      .get(taskId) as { totalSize: number | null } | undefined

    if (sizeRow?.totalSize === null || sizeRow?.totalSize === undefined) {
      return
    }
    if (sizeRow.totalSize <= this.#maxPayloadBytes) {
      return
    }

    while (true) {
      const currentSize = this.#db.raw
        .prepare('SELECT SUM(LENGTH(payload)) as totalSize FROM task_events WHERE task_id = ?')
        .get(taskId) as { totalSize: number | null } | undefined

      if (currentSize?.totalSize === null || currentSize?.totalSize === undefined) {
        break
      }
      if (currentSize.totalSize <= this.#maxPayloadBytes) {
        break
      }

      const oldest = this.#db.raw
        .prepare(
          `SELECT sequence FROM task_events
           WHERE task_id = ? AND kind = 'agent'
           ORDER BY sequence ASC
           LIMIT 1`
        )
        .get(taskId) as { sequence: number } | undefined

      if (oldest === undefined) {
        break
      }

      this.#db.raw
        .prepare('DELETE FROM task_events WHERE task_id = ? AND sequence = ?')
        .run(taskId, oldest.sequence)
    }
  }
}
