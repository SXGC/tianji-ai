/**
 * 将任意抛出值转换为 TianjiError，透传原始 name/message/category。
 *
 * @module task/error-passthrough
 */

import { TianjiError } from '@tianji/shared'

/**
 * 将 catch 块捕获的任意值转换为 TianjiError：
 * - TianjiError 原样透传（保留 category/code/message）
 * - 普通 Error → internal 类别，code = error.name，message = error.message
 * - 非 Error 值 → internal 类别，code = 'unknown'，message = String(value)
 *
 * @param error - catch 块捕获的任意值
 */
export function toPassThroughTianjiError(error: unknown): TianjiError {
  if (error instanceof TianjiError) {
    return error
  }

  if (error instanceof Error) {
    return new TianjiError('internal', error.name || 'Error', error.message, { cause: error })
  }

  return new TianjiError('internal', 'unknown', String(error))
}
