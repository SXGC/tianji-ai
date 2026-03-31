import type {
  ObserverLogEntry,
  ObserverLogLevel,
  ObserverLogScope,
  ObserverLogSink,
  ObserverLogger,
} from './types.js'

import { getDefaultObserverSensitiveKeys, sanitizeObserverLogData } from './sanitize.js'

export interface CreateObserverLoggerOptions {
  readonly sinks: readonly ObserverLogSink[]
  readonly scope?: ObserverLogScope
  readonly bindings?: Record<string, unknown>
  readonly sensitiveKeys?: readonly string[]
}

/**
 * Creates the core observer logger that writes sanitized entries to the provided sink.
 */
export function createObserverLogger(options: CreateObserverLoggerOptions): ObserverLogger {
  const sensitiveKeys = new Set([
    ...getDefaultObserverSensitiveKeys(),
    ...(options.sensitiveKeys ?? []),
  ])

  return createLoggerInstance({
    sinks: options.sinks,
    scope: options.scope,
    bindings: options.bindings,
    sensitiveKeys,
  })
}

interface LoggerState {
  readonly sinks: readonly ObserverLogSink[]
  readonly scope?: ObserverLogScope
  readonly bindings?: Record<string, unknown>
  readonly sensitiveKeys: ReadonlySet<string>
}

function createLoggerInstance(state: LoggerState): ObserverLogger {
  const log = async (
    level: ObserverLogLevel,
    scope: ObserverLogScope,
    message: string,
    data?: Record<string, unknown>
  ): Promise<void> => {
    const mergedScope = mergeScope(state.scope, scope)
    const mergedData = sanitizeObserverLogData(mergeData(state.bindings, data), state.sensitiveKeys)
    const entry: ObserverLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      scope: mergedScope,
      message,
      ...(mergedData === undefined ? {} : { data: mergedData }),
    }

    for (const sink of state.sinks) {
      await sink.write(entry)
    }
  }

  return {
    log,
    trace: (scope, message, data) => log('trace', scope, message, data),
    debug: (scope, message, data) => log('debug', scope, message, data),
    info: (scope, message, data) => log('info', scope, message, data),
    warn: (scope, message, data) => log('warn', scope, message, data),
    error: (scope, message, data) => log('error', scope, message, data),
    fatal: (scope, message, data) => log('fatal', scope, message, data),
    child: (options) =>
      createLoggerInstance({
        sinks: state.sinks,
        scope: options?.scope === undefined ? state.scope : mergeScope(state.scope, options.scope),
        bindings: mergeData(state.bindings, options?.bindings),
        sensitiveKeys: state.sensitiveKeys,
      }),
  }
}

function mergeData(
  bindings: Record<string, unknown> | undefined,
  data: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (bindings === undefined) {
    return data
  }

  if (data === undefined) {
    return { ...bindings }
  }

  return {
    ...bindings,
    ...data,
  }
}

function mergeScope(
  parent: ObserverLogScope | undefined,
  scope: ObserverLogScope
): ObserverLogScope {
  if (parent === undefined) {
    return scope
  }

  return [...parent, ...scope] as ObserverLogScope
}
