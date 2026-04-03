import Database from 'better-sqlite3'

import { SCHEMA_SQL } from './schema.js'

/**
 * Controlplane SQLite 访问句柄。
 */
export interface ControlPlaneDb {
  readonly raw: Database.Database
  close(): void
}

/**
 * 创建并初始化 controlplane 数据库。
 *
 * @param path 数据库文件路径，测试可传 `:memory:`。
 */
export function createDatabase(path: string): ControlPlaneDb {
  const db = new Database(path)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.exec(SCHEMA_SQL)

  return {
    raw: db,
    close() {
      db.close()
    },
  }
}
