import { appendFile, mkdir } from 'node:fs/promises'
import type { UserConfigPaths } from './config.js'

export type CliLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type CliLogScope = readonly [string, ...string[]]

const SENSITIVE_DATA_KEYS = new Set(['apiKey', 'prompt', 'soul'])

export interface CliLogEntry {
  readonly timestamp: string
  readonly level: CliLogLevel
  readonly scope: CliLogScope
  readonly message: string
  readonly data?: Record<string, unknown>
}

export interface CliLogger {
  readonly appendCliLog: (entry: CliLogEntry) => Promise<void>
  readonly logDebug: (
    scope: CliLogScope,
    message: string,
    data?: Record<string, unknown>
  ) => Promise<void>
  readonly logInfo: (
    scope: CliLogScope,
    message: string,
    data?: Record<string, unknown>
  ) => Promise<void>
  readonly logWarn: (
    scope: CliLogScope,
    message: string,
    data?: Record<string, unknown>
  ) => Promise<void>
  readonly logError: (
    scope: CliLogScope,
    message: string,
    data?: Record<string, unknown>
  ) => Promise<void>
}

/**
 * Creates a CLI logger bound to the user log file path.
 *
 * @param paths - The resolved user config paths
 * @returns Logger helpers that append JSONL records into the CLI log file
 */
export function createCliLogger(paths: UserConfigPaths): CliLogger {
  return {
    appendCliLog(entry) {
      return appendCliLog(paths, entry)
    },
    logDebug(scope, message, data) {
      return writeCliLog(paths, 'debug', scope, message, data)
    },
    logInfo(scope, message, data) {
      return writeCliLog(paths, 'info', scope, message, data)
    },
    logWarn(scope, message, data) {
      return writeCliLog(paths, 'warn', scope, message, data)
    },
    logError(scope, message, data) {
      return writeCliLog(paths, 'error', scope, message, data)
    },
  }
}

/**
 * Appends a pre-built JSONL log entry to the CLI log file.
 *
 * @param paths - The resolved user config paths
 * @param entry - The fully structured log entry to persist
 */
export async function appendCliLog(paths: UserConfigPaths, entry: CliLogEntry): Promise<void> {
  await mkdir(paths.logsDir, { recursive: true })
  await appendFile(paths.cliLogFilePath, `${JSON.stringify(entry)}\n`, 'utf8')
}

/**
 * Writes an info-level CLI log entry.
 *
 * @param paths - The resolved user config paths
 * @param scope - The logical module scope
 * @param message - The user or developer facing log message
 * @param data - Optional structured metadata
 */
export function logInfo(
  paths: UserConfigPaths,
  scope: CliLogScope,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  return writeCliLog(paths, 'info', scope, message, data)
}

/**
 * Writes a debug-level CLI log entry.
 *
 * @param paths - The resolved user config paths
 * @param scope - The logical module scope
 * @param message - The user or developer facing log message
 * @param data - Optional structured metadata
 */
export function logDebug(
  paths: UserConfigPaths,
  scope: CliLogScope,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  return writeCliLog(paths, 'debug', scope, message, data)
}

/**
 * Writes an error-level CLI log entry.
 *
 * @param paths - The resolved user config paths
 * @param scope - The logical module scope
 * @param message - The error message
 * @param data - Optional structured metadata
 */
export function logError(
  paths: UserConfigPaths,
  scope: CliLogScope,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  return writeCliLog(paths, 'error', scope, message, data)
}

/**
 * Writes a warn-level CLI log entry.
 *
 * @param paths - The resolved user config paths
 * @param scope - The logical module scope
 * @param message - The warning message
 * @param data - Optional structured metadata
 */
export function logWarn(
  paths: UserConfigPaths,
  scope: CliLogScope,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  return writeCliLog(paths, 'warn', scope, message, data)
}

async function writeCliLog(
  paths: UserConfigPaths,
  level: CliLogLevel,
  scope: CliLogScope,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  const sanitizedData = sanitizeCliLogData(data)
  const entry: CliLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    ...(sanitizedData === undefined ? {} : { data: sanitizedData }),
  }

  await appendCliLog(paths, entry)
}

function sanitizeCliLogData(
  data: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (data === undefined) {
    return undefined
  }

  const sanitizedEntries = Object.entries(data).flatMap(([key, value]) => {
    if (SENSITIVE_DATA_KEYS.has(key)) {
      return []
    }

    return [[key, sanitizeCliLogValue(value)] satisfies readonly [string, unknown]]
  })

  if (sanitizedEntries.length === 0) {
    return undefined
  }

  return Object.fromEntries(sanitizedEntries)
}

function sanitizeCliLogValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCliLogValue(item))
  }

  if (value instanceof Error) {
    return { message: value.message, name: value.name }
  }

  if (typeof value === 'object') {
    const sanitizedEntries = Object.entries(value).flatMap(([key, nestedValue]) => {
      if (SENSITIVE_DATA_KEYS.has(key)) {
        return []
      }

      return [[key, sanitizeCliLogValue(nestedValue)] satisfies readonly [string, unknown]]
    })

    return Object.fromEntries(sanitizedEntries)
  }

  return String(value)
}
