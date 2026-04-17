import type {
  ObserverLogEntry,
  ObserverLogLevel,
  ObserverLogScope,
  ObserverLogSink,
  ObserverLogger,
} from '@tianji/observer'
import { createJsonlFileSink, createObserverLogger, createStderrSink } from '@tianji/observer'
import type { UserConfigPaths } from './config.js'

export type CliLogLevel = Extract<ObserverLogLevel, 'debug' | 'info' | 'warn' | 'error'>
export type CliLogScope = ObserverLogScope
export type CliLogEntry = ObserverLogEntry

export interface CliLogger {
  /** 底层 observer logger 实例，可直接传给需要 ObserverLogger 的组件（如 SessionRuntime）。 */
  readonly observerLogger: ObserverLogger
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

export type RuntimeLogger = Pick<CliLogger, 'logDebug' | 'logInfo' | 'logWarn' | 'logError'>

export interface CreateCliLoggerOptions {
  readonly sink: ObserverLogSink
}

/**
 * Creates a CLI logger adapter backed by the observer logger.
 *
 * @param options - The observer sink used for JSONL persistence
 * @returns Logger helpers with the existing CLI-facing method names
 */
export function createCliLogger(options: CreateCliLoggerOptions): CliLogger {
  const observerLogger = createObserverLogger({
    sinks: [options.sink],
    sensitiveKeys: ['prompt', 'soul'],
  })

  return {
    observerLogger,
    appendCliLog(entry) {
      return options.sink.write(entry)
    },
    logDebug(scope, message, data) {
      return observerLogger.debug(scope, message, data)
    },
    logInfo(scope, message, data) {
      return observerLogger.info(scope, message, data)
    },
    logWarn(scope, message, data) {
      return observerLogger.warn(scope, message, data)
    },
    logError(scope, message, data) {
      return observerLogger.error(scope, message, data)
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
  await createCliLoggerFromPaths(paths).appendCliLog(entry)
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
  return createCliLoggerFromPaths(paths).logInfo(scope, message, data)
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
  return createCliLoggerFromPaths(paths).logDebug(scope, message, data)
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
  return createCliLoggerFromPaths(paths).logError(scope, message, data)
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
  return createCliLoggerFromPaths(paths).logWarn(scope, message, data)
}

export function getCliLogger(paths: UserConfigPaths): CliLogger {
  return createCliLoggerFromPaths(paths)
}

function createCliLoggerFromPaths(paths: UserConfigPaths): CliLogger {
  const fileSink = createJsonlFileSink({ filePath: paths.cliLogFilePath })
  const stderrSink = createStderrSink({ minLevel: 'warn' })
  return createCliLoggerWithSinks(paths, [fileSink, stderrSink])
}

/**
 * Creates a CLI logger backed by an ordered list of observer sinks.
 * The first sink is treated as the primary sink for `appendCliLog` direct writes.
 *
 * @param _paths - Reserved for future path-aware sink configuration
 * @param sinks - Ordered sink list; index 0 is the primary (file) sink
 */
function createCliLoggerWithSinks(
  _paths: UserConfigPaths,
  sinks: readonly ObserverLogSink[]
): CliLogger {
  const observerLogger = createObserverLogger({
    sinks,
    sensitiveKeys: ['prompt', 'soul'],
  })
  const primarySink = sinks[0]
  return {
    observerLogger,
    appendCliLog(entry) {
      return primarySink !== undefined ? primarySink.write(entry) : Promise.resolve()
    },
    logDebug(scope, message, data) {
      return observerLogger.debug(scope, message, data)
    },
    logInfo(scope, message, data) {
      return observerLogger.info(scope, message, data)
    },
    logWarn(scope, message, data) {
      return observerLogger.warn(scope, message, data)
    },
    logError(scope, message, data) {
      return observerLogger.error(scope, message, data)
    },
  }
}
