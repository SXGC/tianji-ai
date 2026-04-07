import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runMigrateCli } from '../migrate-cli.js'

describe('runMigrateCli', () => {
  let tempDir: string | undefined

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('should apply pending sql migrations once', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'controlplane-migrate-cli-'))
    const migrationsDir = join(tempDir, 'migrations')
    const dbPath = join(tempDir, 'controlplane.db')
    const stdout = vi.fn<(message: string) => void>()

    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE nodes (
        node_id TEXT PRIMARY KEY,
        hostname TEXT NOT NULL,
        platform TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline'
          CHECK(status IN ('online', 'offline')),
        execution_state TEXT NOT NULL DEFAULT 'idle'
          CHECK(execution_state IN ('idle', 'busy')),
        access_token_hash TEXT NOT NULL,
        access_token_expires_at INTEGER NOT NULL,
        enrollment_token TEXT NOT NULL,
        last_heartbeat_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    db.close()

    mkdirSync(migrationsDir, { recursive: true })
    writeFileSync(
      join(migrationsDir, '0001_add_nodes_pid.sql'),
      'ALTER TABLE nodes ADD COLUMN pid INTEGER;'
    )

    const exitCode = await runMigrateCli({
      dataDir: tempDir,
      migrationsDir,
      writeStdout: stdout,
    })

    const migratedDb = new Database(dbPath)

    try {
      const columns = migratedDb.prepare('PRAGMA table_info(nodes)').all() as {
        name: string
        type: string
      }[]
      const applied = migratedDb
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as { version: string }[]

      expect(exitCode).toBe(0)
      expect(columns.some((column) => column.name === 'pid' && column.type === 'INTEGER')).toBe(
        true
      )
      expect(applied).toEqual([{ version: '0001_add_nodes_pid.sql' }])
      expect(stdout).toHaveBeenCalledWith('Applied migration: 0001_add_nodes_pid.sql\n')
    } finally {
      migratedDb.close()
    }
  })

  it('should skip already applied migrations', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'controlplane-migrate-cli-'))
    const migrationsDir = join(tempDir, 'migrations')
    const dbPath = join(tempDir, 'controlplane.db')
    const stdout = vi.fn<(message: string) => void>()

    mkdirSync(migrationsDir, { recursive: true })
    writeFileSync(
      join(migrationsDir, '0001_add_nodes_pid.sql'),
      'ALTER TABLE nodes ADD COLUMN pid INTEGER;'
    )

    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE nodes (
        node_id TEXT PRIMARY KEY,
        pid INTEGER
      );

      CREATE TABLE schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `)
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(
      '0001_add_nodes_pid.sql',
      Date.now()
    )
    db.close()

    const exitCode = await runMigrateCli({
      dataDir: tempDir,
      migrationsDir,
      writeStdout: stdout,
    })

    expect(exitCode).toBe(0)
    expect(stdout).toHaveBeenCalledWith('Skipping migration: 0001_add_nodes_pid.sql\n')
  })
})
