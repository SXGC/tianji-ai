import type { ObserverLogEntry, ObserverLogSink } from '../types.js'

export interface CreateStdoutSinkOptions {
  readonly pretty?: boolean
}

/**
 * Creates a sink that writes log entries to stdout.
 */
export function createStdoutSink(options: CreateStdoutSinkOptions = {}): ObserverLogSink {
  return {
    async write(entry) {
      const line = options.pretty === true ? formatPrettyEntry(entry) : JSON.stringify(entry)
      process.stdout.write(`${line}\n`)
    },
  }
}

function formatPrettyEntry(entry: ObserverLogEntry): string {
  const scope = entry.scope.join('.')
  const data = entry.data === undefined ? '' : ` ${JSON.stringify(entry.data)}`

  return `[${entry.level}] ${scope} ${entry.message}${data}`
}
