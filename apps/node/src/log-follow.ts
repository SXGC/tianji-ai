import { open, stat } from 'node:fs/promises'
import type { ObserverLogEntry, ObserverLogScope } from '@tianji/observer'
import { sleep } from '@tianji/shared'

import type { I18n } from './i18n/index.js'

type CliLogEntry = ObserverLogEntry
type CliLogScope = ObserverLogScope
type CliLogLevel = CliLogEntry['level']

const LOG_FOLLOW_POLL_INTERVAL_MS = 500
const LOG_FOLLOW_CHUNK_SIZE = 64 * 1024

export interface FollowCliLogOptions {
  readonly follow?: boolean
  readonly lines?: number
  readonly signal?: AbortSignal
}

/**
 * Follows the CLI JSONL log file and renders records as human-readable text.
 *
 * The current stage uses a simple polling loop so the public module boundary is
 * stable before switching to a more efficient incremental reader later.
 *
 * @param logFilePath - The absolute CLI log file path
 * @param options - Optional follow controls used by tests and callers
 */
export async function followCliLog(
  logFilePath: string,
  i18n: I18n,
  options: FollowCliLogOptions = {}
): Promise<void> {
  let offset = 0
  let remainder = ''
  let hasPrintedWaitingMessage = false
  let lastReadFingerprint = ''
  let hasReplayedInitialLines = false

  while (!options.signal?.aborted) {
    const nextStat = await readCliLogStat(logFilePath)
    if (nextStat === null) {
      if (!hasPrintedWaitingMessage) {
        process.stdout.write(`${i18n.t('log.waiting', { path: logFilePath })}\n`)
        hasPrintedWaitingMessage = true
      }

      await sleep(LOG_FOLLOW_POLL_INTERVAL_MS)
      continue
    }

    if (hasPrintedWaitingMessage) {
      process.stdout.write(`${i18n.t('log.detected', { path: logFilePath })}\n`)
      hasPrintedWaitingMessage = false
    }

    if (!hasReplayedInitialLines) {
      const initialReadOffset = await replayLatestCliLogLines(
        logFilePath,
        nextStat.size,
        options.lines ?? 100,
        i18n
      )
      offset = initialReadOffset
      hasReplayedInitialLines = true
      await sleep(LOG_FOLLOW_POLL_INTERVAL_MS)
      continue
    }

    const fileWasReplaced =
      offset > 0 && (await hasCliLogPrefixChanged(logFilePath, offset, lastReadFingerprint))

    if (nextStat.size < offset || fileWasReplaced) {
      process.stdout.write(`${i18n.t('log.truncated')}\n`)
      offset = 0
      remainder = ''
      lastReadFingerprint = ''
    }

    if (nextStat.size > offset) {
      const chunkResult = await readCliLogChunk(logFilePath, offset, nextStat.size)
      offset = chunkResult.nextOffset
      remainder = renderCliLogChunk(remainder, chunkResult.chunk, i18n)
      lastReadFingerprint = createCliLogFingerprint(chunkResult.chunk)
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
  const level = entry.level.toUpperCase().padEnd(5, ' ')
  const scope = formatCliLogScope(entry.scope).padEnd(24, ' ')

  if (entry.data === undefined) {
    return `${entry.timestamp} ${level} ${scope} ${entry.message}`
  }

  return `${entry.timestamp} ${level} ${scope} ${entry.message} ${JSON.stringify(entry.data)}`
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

    if (!isCliLogScope(parsed.scope)) {
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

async function readCliLogStat(logFilePath: string): Promise<{ readonly size: number } | null> {
  try {
    return await stat(logFilePath)
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

/**
 * Reads the newly appended byte range from the CLI log file.
 *
 * @param logFilePath - The absolute CLI log file path
 * @param offset - The byte offset to start reading from
 * @param fileSize - The current file size from stat
 * @returns The decoded chunk and next byte offset
 */
export async function readCliLogChunk(
  logFilePath: string,
  offset: number,
  fileSize: number
): Promise<{ chunk: string; nextOffset: number }> {
  const fileHandle = await open(logFilePath, 'r')

  try {
    const chunks: Buffer[] = []
    let nextOffset = offset

    while (nextOffset < fileSize) {
      const remainingBytes = fileSize - nextOffset
      const buffer = Buffer.alloc(Math.min(LOG_FOLLOW_CHUNK_SIZE, remainingBytes))
      const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, nextOffset)
      if (bytesRead === 0) {
        break
      }

      chunks.push(buffer.subarray(0, bytesRead))
      nextOffset += bytesRead
    }

    return {
      chunk: Buffer.concat(chunks).toString('utf8'),
      nextOffset,
    }
  } finally {
    await fileHandle.close()
  }
}

/**
 * 启动 follow 前回放文件末尾的最近若干行，避免首次进入时输出整个历史文件。
 *
 * @param logFilePath - CLI 日志文件路径
 * @param fileSize - 当前日志文件大小
 * @param lineCount - 需要回放的尾部行数
 * @returns 回放结束后的下一次读取偏移量
 */
export async function replayLatestCliLogLines(
  logFilePath: string,
  fileSize: number,
  lineCount: number,
  i18n: I18n
): Promise<number> {
  if (fileSize === 0 || lineCount <= 0) {
    return fileSize
  }

  const chunkResult = await readCliLogChunk(logFilePath, 0, fileSize)
  const lines = chunkResult.chunk.split('\n')

  if (lines.at(-1) === '') {
    lines.pop()
  }

  const visibleLines = lines.slice(Math.max(0, lines.length - lineCount))
  for (const line of visibleLines) {
    const parsedEntry = parseCliLogLine(line)
    if (parsedEntry === null) {
      if (line.trim().length > 0) {
        process.stdout.write(`${i18n.t('log.invalid_entry', { line })}\n`)
      }
      continue
    }

    process.stdout.write(`${formatCliLogEntry(parsedEntry)}\n`)
  }

  return chunkResult.nextOffset
}

function renderCliLogChunk(remainder: string, chunk: string, i18n: I18n): string {
  const combinedChunk = `${remainder}${chunk}`
  const lines = combinedChunk.split('\n')
  const nextRemainder = lines.pop() ?? ''

  for (const line of lines) {
    const parsedEntry = parseCliLogLine(line)
    if (parsedEntry === null) {
      if (line.trim().length > 0) {
        process.stdout.write(`[invalid-cli-log] ${line}\n`)
        process.stdout.write(`${i18n.t('log.invalid_entry', { line })}\n`)
      }
      continue
    }

    process.stdout.write(`${formatCliLogEntry(parsedEntry)}\n`)
  }

  return nextRemainder
}

async function hasCliLogPrefixChanged(
  logFilePath: string,
  offset: number,
  expectedFingerprint: string
): Promise<boolean> {
  if (expectedFingerprint.length === 0) {
    return false
  }

  const prefixStart = Math.max(0, offset - LOG_FOLLOW_CHUNK_SIZE)
  const prefixResult = await readCliLogChunk(logFilePath, prefixStart, offset)
  return createCliLogFingerprint(prefixResult.chunk) !== expectedFingerprint
}

function createCliLogFingerprint(chunk: string): string {
  if (chunk.length <= LOG_FOLLOW_CHUNK_SIZE) {
    return chunk
  }

  return chunk.slice(-LOG_FOLLOW_CHUNK_SIZE)
}

function isCliLogLevel(value: unknown): value is CliLogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
}

function isCliLogScope(value: unknown): value is CliLogScope {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.length > 0)
  )
}

function formatCliLogScope(scope: CliLogScope): string {
  return scope.join(' > ')
}
