import type { ObserverLogEntry, ObserverLogLevel, ObserverLogSink } from '../types.js'

import { isLevelAtLeast } from '../level.js'

export interface CreateStderrSinkOptions {
  readonly pretty?: boolean
  /** 仅输出严重程度不低于该级别的日志条目。未指定时不过滤。 */
  readonly minLevel?: ObserverLogLevel
}

/**
 * 创建一个将日志写入 `process.stderr` 的 sink。
 * 语义与 `createStdoutSink` 一致，唯一差别是默认输出口为 stderr，
 * 通常用于让顶层崩溃、fatal/error 日志与常规 stdout 业务输出分离。
 *
 * @param options - 可选配置，支持 pretty 格式化与最低级别过滤
 */
export function createStderrSink(options: CreateStderrSinkOptions = {}): ObserverLogSink {
  const { pretty = false, minLevel } = options
  return {
    async write(entry) {
      if (minLevel !== undefined && !isLevelAtLeast(entry.level, minLevel)) {
        return
      }
      const line = pretty ? formatPrettyEntry(entry) : JSON.stringify(entry)
      process.stderr.write(`${line}\n`)
    },
  }
}

function formatPrettyEntry(entry: ObserverLogEntry): string {
  const scope = entry.scope.join('.')
  const data = entry.data === undefined ? '' : ` ${JSON.stringify(entry.data)}`

  return `[${entry.level}] ${scope} ${entry.message}${data}`
}
