/**
 * 将任意抛出值归一化为可写入日志的结构化数据。
 * - Error: 保留 name / message / stack，并递归展开 cause。
 * - 非 Error：`{ message }`，对普通对象走 JSON 序列化。
 *
 * @module logger/error-formatter
 */

export interface ErrorToLogDataOptions {
  /** 递归展开 cause 的最大深度，默认 5，防止自引用导致死循环。 */
  readonly maxDepth?: number
}

const DEFAULT_MAX_DEPTH = 5

/**
 * 归一化入口。将任意抛出值转为可写入日志的结构化对象。
 *
 * @param err - 任意抛出值（Error 实例、字符串、数字、null、undefined 或普通对象）
 * @param options - 可选配置，支持 maxDepth 控制 cause 递归深度
 * @returns 包含 name / message / stack / cause 等字段的结构化对象
 */
export function errorToLogData(
  err: unknown,
  options: ErrorToLogDataOptions = {}
): Record<string, unknown> {
  return formatAtDepth(err, options.maxDepth ?? DEFAULT_MAX_DEPTH)
}

function formatAtDepth(err: unknown, remainingDepth: number): Record<string, unknown> {
  if (remainingDepth <= 0) {
    return { message: '[truncated: maxDepth reached]' }
  }

  if (err instanceof Error) {
    const data: Record<string, unknown> = {
      name: err.name,
      message: err.message,
    }
    if (typeof err.stack === 'string') {
      data.stack = err.stack
    }
    if (err.cause !== undefined) {
      const nestedDepth = remainingDepth - 1
      data.cause =
        nestedDepth <= 0 ? '[truncated: maxDepth reached]' : formatAtDepth(err.cause, nestedDepth)
    }
    return data
  }

  if (typeof err === 'string') {
    return { message: err }
  }

  if (err === null || err === undefined) {
    return { message: String(err) }
  }

  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
    return { message: String(err) }
  }

  try {
    return { message: JSON.stringify(err) }
  } catch {
    return { message: Object.prototype.toString.call(err) }
  }
}
