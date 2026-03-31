import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ObserverLogSink } from '../types.js'

export interface CreateJsonlFileSinkOptions {
  readonly filePath: string
}

/**
 * Creates a sink that appends each log entry as one JSONL record.
 */
export function createJsonlFileSink(options: CreateJsonlFileSinkOptions): ObserverLogSink {
  return {
    async write(entry) {
      await mkdir(dirname(options.filePath), { recursive: true })
      await appendFile(options.filePath, `${JSON.stringify(entry)}\n`, 'utf8')
    },
  }
}
