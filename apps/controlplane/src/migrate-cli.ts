import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import Database from 'better-sqlite3'

const MIGRATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`

export interface RunMigrateCliOptions {
  readonly dataDir: string
  readonly migrationsDir?: string
  readonly writeStdout?: (message: string) => void
}

/**
 * 执行 controlplane SQL migration。
 */
export async function runMigrateCli(options: RunMigrateCliOptions): Promise<number> {
  const writeStdout = options.writeStdout ?? ((message: string) => process.stdout.write(message))
  const migrationsDir = options.migrationsDir ?? new URL('../migrations', import.meta.url)
  const migrationPath = typeof migrationsDir === 'string' ? migrationsDir : migrationsDir.pathname

  mkdirSync(options.dataDir, { recursive: true })

  const dbPath = join(options.dataDir, 'controlplane.db')
  const db = new Database(dbPath)

  try {
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
    db.exec(MIGRATION_TABLE_SQL)

    const files = readdirSync(migrationPath)
      .filter((name) => name.endsWith('.sql'))
      .sort((left, right) => left.localeCompare(right))

    for (const file of files) {
      const existing = db
        .prepare('SELECT version FROM schema_migrations WHERE version = ?')
        .get(file) as { version: string } | undefined

      if (existing !== undefined) {
        writeStdout(`Skipping migration: ${file}\n`)
        continue
      }

      const sql = readFileSync(join(migrationPath, file), 'utf8')
      const transaction = db.transaction(() => {
        db.exec(sql)
        db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)').run(
          file,
          Date.now()
        )
      })

      transaction()
      writeStdout(`Applied migration: ${file}\n`)
    }

    return 0
  } finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const dataDir =
    process.env.TIANJI_CP_DATA_DIR ?? `${process.env.HOME}/.config/tianji-ai/controlplane`

  process.exitCode = await runMigrateCli({ dataDir })
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  await main()
}
