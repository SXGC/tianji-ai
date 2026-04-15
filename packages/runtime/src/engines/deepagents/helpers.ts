/**
 * deepagents 引擎通用工具函数。
 *
 * 包含序列化、错误归一化、AbortSignal 合成等不依赖业务状态的纯工具函数。
 * 这些 helper 与 packages/runtime/src/runtime/helpers.ts 中的同名函数保持各自独立副本，
 * 不做跨目录合并（详见设计文档 §5 "不做什么"）。
 */
import { CancelledError, TimeoutError, ToolError } from '@tianji/shared'

import type { AbortSignalScope } from './types.js'

/**
 * 以稳定顺序序列化任意值，供工具参数比较和日志占位使用。
 * 该实现额外处理 bigint、循环引用与对象键排序，避免相同语义对象因键顺序不同而无法匹配。
 */
export function stableSerialize(value: unknown): string {
  if (value === undefined) {
    return 'undefined'
  }

  try {
    const seen = new WeakSet<object>()

    return JSON.stringify(value, (_key, candidate) => {
      if (typeof candidate === 'bigint') {
        return `${candidate}n`
      }

      if (!isRecord(candidate) && !Array.isArray(candidate)) {
        return candidate
      }

      if (isRecord(candidate) || Array.isArray(candidate)) {
        if (seen.has(candidate)) {
          return '[Circular]'
        }

        seen.add(candidate)
      }

      if (Array.isArray(candidate)) {
        return candidate
      }

      return sortJsonKeys('', candidate)
    })
  } catch {
    if (typeof value === 'string') {
      return value
    }

    try {
      return JSON.stringify(value) ?? 'undefined'
    } catch {
      return '[Unserializable]'
    }
  }
}

/**
 * 递归前对对象键排序，保证 JSON 序列化结果稳定。
 */
export function sortJsonKeys(_key: string, value: unknown): unknown {
  if (!isRecord(value) || Array.isArray(value)) {
    return value
  }

  return Object.keys(value)
    .sort((a, b) => a.localeCompare(b))
    .reduce<Record<string, unknown>>((record, key) => {
      record[key] = value[key]
      return record
    }, {})
}

/**
 * 判断值是否为非 null 对象。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 递增并返回事件序号。
 */
export function nextSequence(sequence: { current: number }): number {
  sequence.current += 1
  return sequence.current
}

/**
 * 在统一取消信号之上为异步操作叠加超时控制。
 *
 * 该函数会把外部取消与内部 timeout 合并为单个 abortSignal，使用 Promise.race 抢占结果，
 * 并在 finally 中清理所有监听器，避免长生命周期会话中出现事件监听泄漏。
 */
export async function executeWithTimeout<T>(
  operation: (abortSignal?: AbortSignal) => Promise<T>,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<T> {
  if (abortSignal?.aborted) {
    throw new CancelledError('RUN_CANCELLED', 'Run cancelled before tool execution started')
  }

  if (timeoutMs <= 0) {
    return operation(abortSignal)
  }

  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs)
  const combinedSignalScope = createAbortSignalScope(abortSignal, timeoutController.signal)
  const handleAbort = (): CancelledError =>
    new CancelledError('RUN_CANCELLED', 'Run cancelled during tool execution')
  const handleTimeout = (): TimeoutError =>
    new TimeoutError('TOOL_TIMEOUT', `Tool execution exceeded ${timeoutMs}ms`)
  const abortListener = (): void => {
    timeoutReject?.(handleAbort())
  }
  const timeoutListener = (): void => {
    timeoutReject?.(handleTimeout())
  }
  let timeoutReject: ((reason?: unknown) => void) | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutReject = reject
    abortSignal?.addEventListener('abort', abortListener, { once: true })
    timeoutController.signal.addEventListener('abort', timeoutListener, { once: true })
  })

  try {
    return await Promise.race([operation(combinedSignalScope.signal), timeoutPromise])
  } catch (error) {
    if (timeoutController.signal.aborted && !(abortSignal?.aborted ?? false)) {
      throw new TimeoutError('TOOL_TIMEOUT', `Tool execution exceeded ${timeoutMs}ms`, {
        cause: toError(error),
      })
    }

    throw error
  } finally {
    clearTimeout(timeoutId)
    abortSignal?.removeEventListener('abort', abortListener)
    timeoutController.signal.removeEventListener('abort', timeoutListener)
    combinedSignalScope.cleanup()
  }
}

/**
 * 判断错误是否可视为取消中断。
 */
export function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof CancelledError || isAbortError(error) || Boolean(signal?.aborted)
}

/**
 * 判断错误是否为标准 AbortError。
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * 将未知错误规范化为 Error 实例。
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}

/**
 * 将工具执行过程中捕获的未知错误归一化为 ToolError。
 * - 已经是 ToolError 直接返回。
 * - TimeoutError 映射为 TOOL_TIMEOUT。
 * - 其余情况包装为 TOOL_EXECUTION_FAILED。
 */
export function resolveToolError(error: unknown): ToolError {
  if (error instanceof ToolError) {
    return error
  }
  if (error instanceof TimeoutError) {
    return new ToolError('TOOL_TIMEOUT', error.message, { cause: error })
  }
  const wrapped = toError(error)
  return new ToolError('TOOL_EXECUTION_FAILED', wrapped.message, { cause: wrapped })
}

/**
 * 合并多个 AbortSignal，并返回可清理的监听作用域。
 * 只要任一信号中断，合成信号就会立刻中断；cleanup 用于移除注册的事件监听器。
 */
export function createAbortSignalScope(
  ...signals: Array<AbortSignal | undefined>
): AbortSignalScope {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined)

  if (activeSignals.length === 0) {
    return {
      signal: undefined,
      cleanup: () => {},
    }
  }

  if (activeSignals.length === 1) {
    return {
      signal: activeSignals[0],
      cleanup: () => {},
    }
  }

  const controller = new AbortController()

  if (activeSignals.some((signal) => signal.aborted)) {
    controller.abort()
    return {
      signal: controller.signal,
      cleanup: () => {},
    }
  }

  const listeners = activeSignals.map((signal) => {
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    return { signal, abort }
  })

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const listener of listeners) {
        listener.signal.removeEventListener('abort', listener.abort)
      }
    },
  }
}
