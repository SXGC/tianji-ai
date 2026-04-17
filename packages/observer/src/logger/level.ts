import type { ObserverLogLevel } from './types.js'

/**
 * 各日志级别的数值权重，用于级别过滤比较。
 * 数值越大代表越严重，`fatal` 为最高。
 */
export const LOG_LEVEL_ORDER: Readonly<Record<ObserverLogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

/**
 * 判断 `actual` 的严重程度是否不低于 `threshold`。
 *
 * @param actual - 当前日志条目的级别
 * @param threshold - 允许通过的最低级别
 */
export function isLevelAtLeast(actual: ObserverLogLevel, threshold: ObserverLogLevel): boolean {
  return LOG_LEVEL_ORDER[actual] >= LOG_LEVEL_ORDER[threshold]
}
