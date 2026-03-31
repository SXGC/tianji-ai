export type ObserverLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export type ObserverLogScope = readonly [string, ...string[]]

export interface ObserverLogEntry {
  readonly timestamp: string
  readonly level: ObserverLogLevel
  readonly scope: ObserverLogScope
  readonly message: string
  readonly data?: Record<string, unknown>
}

export interface ObserverLogSink {
  write(entry: ObserverLogEntry): Promise<void>
}

export interface ObserverLogger {
  log(
    level: ObserverLogLevel,
    scope: ObserverLogScope,
    message: string,
    data?: Record<string, unknown>
  ): Promise<void>
  trace(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  debug(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  info(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  warn(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  error(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  fatal(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  child(options?: {
    scope?: ObserverLogScope
    bindings?: Record<string, unknown>
  }): ObserverLogger
}
