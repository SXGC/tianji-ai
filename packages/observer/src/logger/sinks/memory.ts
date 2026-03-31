import type { ObserverLogEntry, ObserverLogSink } from '../types.js'

export interface ObserverMemorySink extends ObserverLogSink {
  readonly entries: ObserverLogEntry[]
}

/**
 * Creates an in-memory sink for tests and temporary inspection.
 */
export function createMemorySink(): ObserverMemorySink {
  const entries: ObserverLogEntry[] = []

  return {
    entries,
    async write(entry) {
      entries.push(entry)
    },
  }
}
