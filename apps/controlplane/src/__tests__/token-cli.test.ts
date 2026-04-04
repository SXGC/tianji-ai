import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDatabase } from '../db/index.js'
import { createEnrollmentToken, formatRegisterUrl, runTokenCreateCli } from '../token-cli.js'

describe('token cli helpers', () => {
  it('formats register url with token', () => {
    expect(formatRegisterUrl('http://127.0.0.1:3000', 'dev-token')).toBe(
      'http://127.0.0.1:3000/register?enrollment-token=dev-token'
    )
  })

  it('stores created enrollment token in database', () => {
    const db = createDatabase(':memory:')

    try {
      const token = createEnrollmentToken(db, 'dev-token')
      const row = db.raw
        .prepare('SELECT token FROM enrollment_tokens WHERE token = ?')
        .get(token) as { token: string } | undefined

      expect(token).toBe('dev-token')
      expect(row?.token).toBe('dev-token')
    } finally {
      db.close()
    }
  })
})

describe('runTokenCreateCli', () => {
  let tempDir: string | undefined

  afterEach(() => {
    if (tempDir !== undefined) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('creates token and prints register url', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'controlplane-token-cli-'))
    const dbPath = join(tempDir, 'controlplane.db')
    const stdout = vi.fn<(message: string) => void>()

    const exitCode = await runTokenCreateCli({
      baseUrl: 'http://127.0.0.1:3000',
      dataDir: tempDir,
      token: 'dev-token',
      writeStdout: stdout,
    })

    const db = createDatabase(dbPath)

    try {
      const row = db.raw
        .prepare('SELECT token FROM enrollment_tokens WHERE token = ?')
        .get('dev-token') as { token: string } | undefined

      expect(exitCode).toBe(0)
      expect(row?.token).toBe('dev-token')
      expect(stdout).toHaveBeenCalledWith(
        expect.stringContaining('http://127.0.0.1:3000/register?enrollment-token=dev-token')
      )
    } finally {
      db.close()
    }
  })
})
