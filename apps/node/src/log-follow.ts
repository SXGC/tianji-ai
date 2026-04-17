import { open, stat } from 'node:fs/promises'
import type { ObserverLogEntry, ObserverLogScope } from '@tianji/observer'
import { sleep } from '@tianji/shared'

import type { I18n } from './i18n/index.js'

const LOG_DISPLAY_TIMEZONE = 'Asia/Shanghai'

type CliLogEntry = ObserverLogEntry
type CliLogScope = ObserverLogScope
type CliLogLevel = CliLogEntry['level']

const LOG_FOLLOW_POLL_INTERVAL_MS = 500
const LOG_FOLLOW_CHUNK_SIZE = 64 * 1024

const ANSI_RESET = '\x1b[0m'
const LOG_LEVEL_ANSI_COLORS: Record<CliLogLevel, string> = {
  trace: '\x1b[90m',
  debug: '\x1b[90m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[35m',
}

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
  let lastIno = 0
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
      await replayLatestCliLogLines(logFilePath, nextStat.size, options.lines ?? 100, i18n)
      offset = nextStat.size
      lastIno = nextStat.ino
      hasReplayedInitialLines = true
      await sleep(LOG_FOLLOW_POLL_INTERVAL_MS)
      continue
    }

    const fileWasReplaced = lastIno !== 0 && nextStat.ino !== lastIno

    if (nextStat.size < offset || fileWasReplaced) {
      process.stdout.write(`${i18n.t('log.truncated')}\n`)
      offset = 0
      remainder = ''
    }

    lastIno = nextStat.ino

    if (nextStat.size > offset) {
      const chunkResult = await readCliLogChunk(logFilePath, offset, nextStat.size)
      offset = chunkResult.nextOffset
      remainder = renderCliLogChunk(remainder, chunkResult.chunk, i18n)
    }

    await sleep(LOG_FOLLOW_POLL_INTERVAL_MS)
  }
}

/**
 * Formats a structured CLI log entry into a human-readable line.
 *
 * @param entry - The parsed CLI log entry
 * @param colorize - When true, applies ANSI color to the level label
 * @returns A single formatted text line
 */
/**
 * 将 ISO 时间字符串转换为上海时区格式化输出。
 *
 * 使用 `Intl.DateTimeFormat` 进行时区转换，确保在不同 Node.js 版本
 * 和操作系统上都能正确工作，无需额外依赖。
 */
function formatTimestampToShanghai(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: LOG_DISPLAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = formatter.formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

export function formatCliLogEntry(entry: CliLogEntry, colorize = false): string {
  const level = colorize ? colorizeLevel(entry.level) : entry.level.toUpperCase().padEnd(5, ' ')
  const scope = formatCliLogScope(entry.scope).padEnd(24, ' ')
  const ts = formatTimestampToShanghai(entry.timestamp)

  if (entry.data === undefined) {
    return `${ts} ${level} ${scope} ${entry.message}`
  }

  return `${ts} ${level} ${scope} ${entry.message} ${JSON.stringify(entry.data)}`
}

/**
 * Returns whether stdout is attached to an interactive terminal.
 *
 * Used to decide whether ANSI color codes should be emitted; when the output
 * is piped or redirected the escape sequences would corrupt the text.
 */
export function supportsColor(): boolean {
  return process.stdout.isTTY === true
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

async function readCliLogStat(
  logFilePath: string
): Promise<{ readonly size: number; readonly ino: number } | null> {
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
 * 从文件尾部向前分块扫描，读取包含最后 N 行所需的尾部文本。
 *
 * 避免首次回放时将整个日志文件读入内存。从文件末尾按块向前读取，
 * 统计换行符数量，收集到足够行数后立即停止。
 *
 * @param logFilePath - CLI 日志文件路径
 * @param fileSize - 当前日志文件大小
 * @param lineCount - 需要的尾部行数
 * @returns 尾部文本内容
 */
/**
 * 在 chunk 中从后向前扫描换行符，统计行数。
 * 找到目标行数时提前返回结果字符串，否则返回 null。
 */
function scanChunkForNewlines(
  chunk: Buffer,
  bytesRead: number,
  startLinesFound: number,
  lineCount: number,
  collectedChunks: Buffer[]
): { linesFound: number; result: string | null } {
  let linesFound = startLinesFound
  for (let i = bytesRead - 1; i >= 0; i--) {
    if (chunk[i] === 0x0a) {
      linesFound++
      if (linesFound >= lineCount) {
        const collected = chunk.subarray(i + 1)
        if (collected.length > 0) {
          collectedChunks.unshift(collected)
        }
        return { linesFound, result: Buffer.concat(collectedChunks).toString('utf8') }
      }
    }
  }
  return { linesFound, result: null }
}

export async function readCliLogTail(
  logFilePath: string,
  fileSize: number,
  lineCount: number
): Promise<string> {
  if (fileSize === 0 || lineCount <= 0) {
    return ''
  }

  const fileHandle = await open(logFilePath, 'r')

  try {
    const tailByte = Buffer.alloc(1)
    const { bytesRead: tailBytesRead } = await fileHandle.read(tailByte, 0, 1, fileSize - 1)
    const fileEndsWithNewline = tailBytesRead > 0 && tailByte[0] === 0x0a

    const collectedChunks: Buffer[] = []
    let readEnd = fileEndsWithNewline ? fileSize - 1 : fileSize
    let linesFound = 0

    while (readEnd > 0 && linesFound < lineCount) {
      const readStart = Math.max(0, readEnd - LOG_FOLLOW_CHUNK_SIZE)
      const readLength = readEnd - readStart
      const buffer = Buffer.alloc(readLength)
      const { bytesRead } = await fileHandle.read(buffer, 0, readLength, readStart)

      if (bytesRead === 0) {
        break
      }

      const readChunk = buffer.subarray(0, bytesRead)

      const scan = scanChunkForNewlines(
        readChunk,
        bytesRead,
        linesFound,
        lineCount,
        collectedChunks
      )
      linesFound = scan.linesFound
      if (scan.result !== null) {
        return scan.result
      }

      collectedChunks.unshift(readChunk)
      readEnd = readStart
    }

    return Buffer.concat(collectedChunks).toString('utf8')
  } finally {
    await fileHandle.close()
  }
}

/**
 * 启动 follow 前回放文件末尾的最近若干行，避免首次进入时输出整个历史文件。
 *
 * 使用尾部反向扫描策略，只读取覆盖最后 N 行所需的文件尾部数据。
 *
 * @param logFilePath - CLI 日志文件路径
 * @param fileSize - 当前日志文件大小
 * @param lineCount - 需要回放的尾部行数
 * @returns 回放结束后的下一次读取偏移量（即文件末尾）
 */
export async function replayLatestCliLogLines(
  logFilePath: string,
  fileSize: number,
  lineCount: number,
  i18n: I18n
): Promise<void> {
  if (fileSize === 0 || lineCount <= 0) {
    return
  }

  const tailText = await readCliLogTail(logFilePath, fileSize, lineCount)
  const lines = tailText.split('\n')

  if (lines.at(-1) === '') {
    lines.pop()
  }

  for (const line of lines) {
    const parsedEntry = parseCliLogLine(line)
    if (parsedEntry === null) {
      if (line.trim().length > 0) {
        process.stdout.write(`${i18n.t('log.invalid_entry', { line })}\n`)
      }
      continue
    }

    process.stdout.write(`${formatCliLogEntry(parsedEntry, supportsColor())}\n`)
  }
}

function renderCliLogChunk(remainder: string, chunk: string, i18n: I18n): string {
  const combinedChunk = `${remainder}${chunk}`
  const lines = combinedChunk.split('\n')
  const nextRemainder = lines.pop() ?? ''
  const useColor = supportsColor()

  for (const line of lines) {
    const parsedEntry = parseCliLogLine(line)
    if (parsedEntry === null) {
      if (line.trim().length > 0) {
        process.stdout.write(`${i18n.t('log.invalid_entry', { line })}\n`)
      }
      continue
    }

    process.stdout.write(`${formatCliLogEntry(parsedEntry, useColor)}\n`)
  }

  return nextRemainder
}

function isCliLogLevel(value: unknown): value is CliLogLevel {
  return (
    value === 'trace' ||
    value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error' ||
    value === 'fatal'
  )
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

function colorizeLevel(level: string): string {
  const code = LOG_LEVEL_ANSI_COLORS[level as CliLogLevel]
  if (!code) {
    return level.toUpperCase().padEnd(5, ' ')
  }

  return `${code}${level.toUpperCase().padEnd(5, ' ')}${ANSI_RESET}`
}
