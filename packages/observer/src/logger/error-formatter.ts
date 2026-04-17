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
  /**
   * 脱敏键集合。当 cause 是普通对象时，其中对应键名的字段会在序列化前被剔除。
   * 不提供时不做脱敏，与历史行为兼容。
   */
  readonly sensitiveKeys?: ReadonlySet<string>
}

const DEFAULT_MAX_DEPTH = 5

/**
 * 归一化入口。将任意抛出值转为可写入日志的结构化对象。
 *
 * @param err - 任意抛出值（Error 实例、字符串、数字、null、undefined 或普通对象）
 * @param options - 可选配置，支持 maxDepth 控制 cause 递归深度，sensitiveKeys 控制 cause 普通对象脱敏
 * @returns 包含 name / message / stack / cause 等字段的结构化对象
 */
export function errorToLogData(
  err: unknown,
  options: ErrorToLogDataOptions = {}
): Record<string, unknown> {
  return formatAtDepth(err, options.maxDepth ?? DEFAULT_MAX_DEPTH, options.sensitiveKeys)
}

function formatAtDepth(
  err: unknown,
  remainingDepth: number,
  sensitiveKeys: ReadonlySet<string> | undefined
): Record<string, unknown> {
  if (remainingDepth <= 0) {
    return { message: '[truncated: maxDepth reached]' }
  }

  if (err instanceof Error) {
    const data: Record<string, unknown> = {
      name: typeof err.name === 'string' ? err.name : String(err.name),
      message: typeof err.message === 'string' ? err.message : String(err.message),
    }

    // Issue 1: stack getter 可能抛出，捕获后降级为哨兵字符串
    let stackValue: unknown
    try {
      stackValue = err.stack
    } catch (stackErr) {
      stackValue = `[stack unavailable: ${stackErr instanceof Error ? stackErr.message : String(stackErr)}]`
    }
    if (typeof stackValue === 'string') {
      data.stack = stackValue
    }

    // Issue 1: cause getter 可能抛出，捕获后设置哨兵
    let causeValue: unknown
    let causeAccessFailed = false
    try {
      causeValue = err.cause
    } catch {
      causeAccessFailed = true
    }

    if (causeAccessFailed) {
      data.cause = '[cause unavailable]'
    } else if (causeValue !== undefined) {
      const nestedDepth = remainingDepth - 1
      data.cause =
        nestedDepth <= 0
          ? '[truncated: maxDepth reached]'
          : formatAtDepth(causeValue, nestedDepth, sensitiveKeys)
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

  // Issue 3: 普通对象序列化前先做浅层脱敏（当 sensitiveKeys 存在时）
  try {
    const serializable =
      sensitiveKeys !== undefined && isPlainObject(err) ? redactShallow(err, sensitiveKeys) : err
    return { message: JSON.stringify(serializable) }
  } catch {
    return { message: Object.prototype.toString.call(err) }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}

/**
 * 浅层剔除敏感键，不修改原对象。
 */
function redactShallow(
  value: Record<string, unknown>,
  sensitiveKeys: ReadonlySet<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (sensitiveKeys.has(k)) continue
    out[k] = v
  }
  return out
}
