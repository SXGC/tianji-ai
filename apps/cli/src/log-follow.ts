import { readFile } from 'node:fs/promises'
import { sleep } from '@tianji/shared'
import type { CliLogEntry, CliLogLevel } from './logger.js'

const LOG_FOLLOW_POLL_INTERVAL_MS = 500

/**
 * Follows the CLI JSONL log file and renders records as human-readable text.
 *
 * The current stage uses a simple polling loop so the public module boundary is
 * stable before switching to a more efficient incremental reader later.
 *
 * @param logFilePath - The absolute CLI log file path
 */
export async function followCliLog(logFilePath: string): Promise<void> {
  let consumedLength = 0
  let remainder = ''
  let hasPrintedWaitingMessage = false

  while (true) {
    const logContent = await readCliLogFile(logFilePath)
    if (logContent === null) {
      if (!hasPrintedWaitingMessage) {
        process.stdout.write(`Waiting for CLI log file: ${logFilePath}\n`)
        hasPrintedWaitingMessage = true
      }

      await sleep(LOG_FOLLOW_POLL_INTERVAL_MS)
      continue
    }

    hasPrintedWaitingMessage = false
    if (logContent.length < consumedLength) {
      consumedLength = 0
      remainder = ''
    }

    if (logContent.length > consumedLength) {
      const nextChunk = logContent.slice(consumedLength)
      consumedLength = logContent.length
      remainder = renderCliLogChunk(remainder, nextChunk)
    }

    await sleep(LOG_FOLLOW_POLL_INTERVAL_MS)
  }
}

/**
 * Formats a structured CLI log entry into a human-readable line.
 *
 * @param entry - The parsed CLI log entry
 * @returns A single formatted text line
 */
export function formatCliLogEntry(entry: CliLogEntry): string {
  const prefix = `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.scope}`
  if (entry.data === undefined) {
    return `${prefix}: ${entry.message}`
  }

  return `${prefix}: ${entry.message} ${JSON.stringify(entry.data)}`
}

/**
 * Parses one JSONL line into a structured CLI log entry.
 *
 * @param line - One raw JSONL line
 * @returns The parsed entry, or `null` when the line is invalid
 */
export function parseCliLogLine(line: string): CliLogEntry | null {
  const trimmedLine = line.trim()
  if (trimmedLine.length === 0) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmedLine) as Record<string, unknown>
    if (!isCliLogLevel(parsed.level)) {
      return null
    }

    if (typeof parsed.timestamp !== 'string') {
      return null
    }

    if (typeof parsed.scope !== 'string') {
      return null
    }

    if (typeof parsed.message !== 'string') {
      return null
    }

    if (
      parsed.data !== undefined &&
      (parsed.data === null || Array.isArray(parsed.data) || typeof parsed.data !== 'object')
    ) {
      return null
    }

    return {
      timestamp: parsed.timestamp,
      level: parsed.level,
      scope: parsed.scope,
      message: parsed.message,
      ...(parsed.data === undefined ? {} : { data: parsed.data as Record<string, unknown> }),
    }
  } catch {
    return null
  }
}

async function readCliLogFile(logFilePath: string): Promise<string | null> {
  try {
    return await readFile(logFilePath, 'utf8')
  } catch (error) {
    const errorCode =
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined

    if (errorCode === 'ENOENT') {
      return null
    }

    throw error
  }
}

function renderCliLogChunk(remainder: string, chunk: string): string {
  const combinedChunk = `${remainder}${chunk}`
  const lines = combinedChunk.split('\n')
  const nextRemainder = lines.pop() ?? ''

  for (const line of lines) {
    const parsedEntry = parseCliLogLine(line)
    if (parsedEntry === null) {
      if (line.trim().length > 0) {
        process.stdout.write(`[invalid-cli-log] ${line}\n`)
      }
      continue
    }

    process.stdout.write(`${formatCliLogEntry(parsedEntry)}\n`)
  }

  return nextRemainder
}

function isCliLogLevel(value: unknown): value is CliLogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
}
