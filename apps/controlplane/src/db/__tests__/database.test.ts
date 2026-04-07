import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../database.js'

describe('ControlPlaneDb', () => {
  let db: ControlPlaneDb
  let dbPath: string | undefined

  afterEach(() => {
    db?.close()
    if (dbPath !== undefined) {
      rmSync(dbPath, { force: true })
      rmSync(`${dbPath}-shm`, { force: true })
      rmSync(`${dbPath}-wal`, { force: true })
      dbPath = undefined
    }
  })

  it('should create all tables on init', () => {
    db = createDatabase(':memory:')
    const tables = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[]

    const tableNames = tables.map((table) => table.name)
    expect(tableNames).toContain('enrollment_tokens')
    expect(tableNames).toContain('nodes')
    expect(tableNames).toContain('agents')
    expect(tableNames).toContain('commands')
    expect(tableNames).toContain('tasks')
    expect(tableNames).toContain('sessions')
    expect(tableNames).toContain('task_sessions')
    expect(tableNames).toContain('task_events')
  })

  it('should enable WAL mode', () => {
    dbPath = join(tmpdir(), `controlplane-${Date.now()}.sqlite`)
    db = createDatabase(dbPath)
    const result = db.raw.pragma('journal_mode') as { journal_mode: string }[]

    expect(result[0]!.journal_mode).toBe('wal')
  })

  it('should enforce foreign keys', () => {
    db = createDatabase(':memory:')
    const result = db.raw.pragma('foreign_keys') as { foreign_keys: number }[]

    expect(result[0]!.foreign_keys).toBe(1)
  })

  it('should create nodes table with pid column in current schema', () => {
    db = createDatabase(':memory:')

    const columns = db.raw.prepare('PRAGMA table_info(nodes)').all() as {
      name: string
      type: string
    }[]

    expect(columns.some((column) => column.name === 'pid' && column.type === 'INTEGER')).toBe(true)
  })
})
