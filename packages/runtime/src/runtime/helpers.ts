/**
 * runtime 模块通用工具函数。
 *
 * 业务职责：
 * - abort signal 合并与生命周期管理。
 * - 错误归一化（Error / TianjiError 转换）。
 * - lineage 字段构造、toolCatalog 归一化。
 * - 副作用判断、类型守卫。
 *
 * 对外触点：
 * - 被 runtime/session-runtime.ts 和 run-lifecycle.ts 引用。
 * - 不对外 re-export（均为内部符号）。
 */
import { CancelledError, ProviderError, type RunSnapshot, TianjiError } from '@tianji/shared'

import { ToolRegistry } from '../tool-catalog.js'
import type { ToolCatalog } from '../tool-catalog.js'
import type { AbortSignalScope, RunLineageFields, SessionRuntimeOptions } from './types.js'

// ── lineage ──────────────────────────────────────────────────────────────────

/**
 * 从 fields 中提取并返回 RunLineageFields，保证只传递已定义的字段。
 */
export function createRunLineageFields(fields: RunLineageFields): RunLineageFields {
  return {
    sessionId: fields.sessionId,
    runId: fields.runId,
    triggerType: fields.triggerType,
    parentRunId: fields.parentRunId,
  }
}

// ── toolCatalog 归一化 ────────────────────────────────────────────────────────

/**
 * 将 SessionRuntimeOptions 中的 toolCatalog 归一化为内部 ToolCatalog 对象。
 */
export function normalizeToolCatalog(
  toolCatalog: SessionRuntimeOptions['toolCatalog']
): ToolCatalog {
  if (toolCatalog === undefined) {
    return new ToolRegistry()
  }

  if (toolCatalog instanceof ToolRegistry) {
    return toolCatalog.createCatalog()
  }

  if (Array.isArray(toolCatalog)) {
    return new ToolRegistry(toolCatalog).createCatalog()
  }

  if (isToolCatalog(toolCatalog)) {
    return toolCatalog
  }

  return new ToolRegistry()
}

function isToolCatalog(value: SessionRuntimeOptions['toolCatalog']): value is ToolCatalog {
  return value !== undefined && !Array.isArray(value) && !(value instanceof ToolRegistry)
}

// ── abort signal ──────────────────────────────────────────────────────────────

/**
 * 合并多个 AbortSignal 为一个，任意一个 abort 即触发合并后的 signal。
 * 返回 cleanup 函数，run 结束后必须调用以移除监听器。
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

// ── 错误归一化 ─────────────────────────────────────────────────────────────────

export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }

  return new Error(String(error))
}

export function toTianjiError(error: unknown): TianjiError {
  if (error instanceof TianjiError) {
    return error
  }

  return new ProviderError('RUNTIME_EXECUTION_FAILED', toError(error).message, {
    cause: toError(error),
  })
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  return error instanceof CancelledError || isAbortError(error) || Boolean(signal?.aborted)
}

// ── 副作用判断 ─────────────────────────────────────────────────────────────────

/**
 * 检查当前 run 的 pendingOperations 中是否包含副作用。
 * 用于决定取消后的 resumeHint 是 'replay' 还是 'require-user-confirmation'。
 */
export function hasSideEffect(
  pendingOperations: Map<string, RunSnapshot['pendingOperations'][number]>,
  destructiveOperationIds: ReadonlySet<string>
): boolean {
  return [...pendingOperations.values()].some(
    (operation) =>
      operation.status === 'aborted-with-side-effect' ||
      (operation.status === 'completed' && destructiveOperationIds.has(operation.id))
  )
}
