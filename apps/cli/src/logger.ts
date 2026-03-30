import { appendFile, mkdir } from 'node:fs/promises'
import type { UserConfigPaths } from './config.js'

export type CliLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface CliLogEntry {
  readonly timestamp: string
  readonly level: CliLogLevel
  readonly scope: string
  readonly message: string
  readonly data?: Record<string, unknown>
}

export interface CliLogger {
  readonly appendCliLog: (entry: CliLogEntry) => Promise<void>
  readonly logInfo: (
    scope: string,
    message: string,
    data?: Record<string, unknown>
  ) => Promise<void>
  readonly logWarn: (
    scope: string,
    message: string,
    data?: Record<string, unknown>
  ) => Promise<void>
  readonly logError: (
    scope: string,
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
  scope: string,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  return writeCliLog(paths, 'info', scope, message, data)
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
  scope: string,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  return writeCliLog(paths, 'error', scope, message, data)
}

async function writeCliLog(
  paths: UserConfigPaths,
  level: CliLogLevel,
  scope: string,
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  const entry: CliLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    ...(data === undefined ? {} : { data }),
  }

  await appendCliLog(paths, entry)
}
