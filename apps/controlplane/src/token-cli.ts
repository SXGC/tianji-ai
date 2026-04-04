import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'

import { createDatabase } from './db/index.js'

export interface TokenCreateCliOptions {
  readonly baseUrl: string
  readonly dataDir: string
  readonly token?: string
  readonly writeStdout?: (message: string) => void
}

/**
 * Formats a node register URL for a given base URL and enrollment token.
 */
export function formatRegisterUrl(baseUrl: string, token: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
  return `${normalizedBaseUrl}/register?enrollment-token=${token}`
}

/**
 * Persists a new enrollment token in the controlplane database.
 */
export function createEnrollmentToken(
  db: ReturnType<typeof createDatabase>,
  token?: string
): string {
  const resolvedToken = token?.trim() || randomBytes(18).toString('base64url')

  db.raw
    .prepare('INSERT INTO enrollment_tokens(token, created_at) VALUES(?, ?)')
    .run(resolvedToken, Date.now())

  return resolvedToken
}

/**
 * Creates an enrollment token and prints the matching register URL.
 */
export async function runTokenCreateCli(options: TokenCreateCliOptions): Promise<number> {
  mkdirSync(options.dataDir, { recursive: true })

  const db = createDatabase(`${options.dataDir}/controlplane.db`)
  const writeStdout = options.writeStdout ?? ((message: string) => process.stdout.write(message))

  try {
    const token = createEnrollmentToken(db, options.token)
    writeStdout(`Enrollment token: ${token}\n`)
    writeStdout(`Register URL: ${formatRegisterUrl(options.baseUrl, token)}\n`)
    return 0
  } finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const dataDir =
    process.env.TIANJI_CP_DATA_DIR ?? `${process.env.HOME}/.config/tianji-ai/controlplane`
  const baseUrl = process.env.TIANJI_CP_PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000'
  const token = process.argv[2]

  process.exitCode = await runTokenCreateCli({
    baseUrl,
    dataDir,
    token,
  })
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  await main()
}
