/**
 * deepagents 配置解析层。
 *
 * 将用户传入的 SessionRuntimeDeepagentsConfig 中各字段解析为 deepagents 可接受的值，包括：
 * - checkpointer / store / backend / interruptOn / middleware / subagents 的占位过滤与拷贝
 * - LLM 录制 raw 数据的持久化（persistLlmRaw）
 * - deepagents.model 与 checkpointer 的守卫函数
 */
import type { LlmCallRecorder } from '../../llm-call-recorder.js'
import { LlmRawStore } from '../../llm-raw-store.js'
import type { SessionRuntimeDeepagentsConfig } from '../../types.js'
import { isRecord } from './helpers.js'
import type { ExecuteDeepagentsRunOptions } from './types.js'

/**
 * 解析 checkpointer 配置，占位配置或无效值时返回 undefined。
 */
export function resolveDeepagentsCheckpointer(
  value: SessionRuntimeDeepagentsConfig['checkpointer']
) {
  if (value === undefined || typeof value === 'boolean') {
    return value
  }

  if (isPlaceholderConfig(value)) {
    return undefined
  }

  return value
}

/**
 * 当数组有效且非空时返回其浅拷贝，否则返回 undefined。
 * 用于统一处理 middleware / subagents 等可选数组配置，避免共享可变引用。
 */
export function resolveOptionalArray<T>(value: readonly T[] | undefined): T[] | undefined {
  if (value === undefined || value.length === 0) {
    return undefined
  }

  return [...value]
}

/**
 * 解析 middleware 配置并复制数组，避免调用方后续修改原始引用。
 */
export function resolveDeepagentsMiddleware(value: SessionRuntimeDeepagentsConfig['middleware']) {
  return resolveOptionalArray(value)
}

/**
 * 将用户 middleware 与录制 middleware 合并。
 * 录制 middleware 放在末尾，确保录到的是最终发给模型的请求。
 */
export function buildMiddlewareList(
  userMiddleware: SessionRuntimeDeepagentsConfig['middleware'],
  recordingMiddleware: unknown
): unknown[] | undefined {
  const user = resolveDeepagentsMiddleware(userMiddleware)
  if (recordingMiddleware === undefined) {
    return user
  }
  if (user !== undefined) {
    return [...user, recordingMiddleware]
  }
  return [recordingMiddleware]
}

/**
 * 将本次 runTurn 的 LLM 调用记录持久化到 raws/ 目录。
 * 只在配置了 llmRawDir 且有调用记录时才写文件。
 * 持久化失败不阻断主流程，只记录 error 日志。
 */
export async function persistLlmRaw(
  options: ExecuteDeepagentsRunOptions,
  recorder: LlmCallRecorder | undefined
): Promise<void> {
  if (recorder === undefined) return

  const record = recorder.toRecord(options.runId, options.sessionId)
  if (record.calls.length === 0) return

  const store = new LlmRawStore(options.llmRawDir!)
  try {
    await store.write(record)
  } catch (error) {
    options.logger?.error(
      ['runtime', 'llm-raw'],
      `failed to persist LLM raw record for run ${options.runId}`,
      { error }
    )
  }
}

/**
 * 解析 subagents 配置并复制数组，避免共享可变引用。
 */
export function resolveDeepagentsSubagents(value: SessionRuntimeDeepagentsConfig['subagents']) {
  return resolveOptionalArray(value)
}

/**
 * 解析 store 配置，占位配置时返回 undefined。
 */
export function resolveDeepagentsStore(value: SessionRuntimeDeepagentsConfig['store']) {
  if (value === undefined || isPlaceholderConfig(value)) {
    return undefined
  }

  return value
}

/**
 * 解析 backend 配置，过滤 null / 占位配置。
 */
export function resolveDeepagentsBackend(value: SessionRuntimeDeepagentsConfig['backend']) {
  if (value === undefined || value === null || isPlaceholderConfig(value)) {
    return undefined
  }

  return value
}

/**
 * 深拷贝 interruptOn 配置，避免 deepagents 在运行期间修改调用方传入对象。
 */
export function resolveDeepagentsInterruptOn(value: SessionRuntimeDeepagentsConfig['interruptOn']) {
  if (value === undefined) {
    return undefined
  }

  return Object.fromEntries(
    Object.entries(value).map(([toolName, config]) => {
      if (typeof config === 'boolean') {
        return [toolName, config]
      }

      return [
        toolName,
        {
          ...config,
          allowedDecisions: [...config.allowedDecisions],
        },
      ]
    })
  )
}

/**
 * 判断配置对象是否为 runtime 内部占位标记。
 */
export function isPlaceholderConfig(value: unknown): value is { readonly kind: string } {
  return isRecord(value) && typeof value.kind === 'string'
}

/**
 * 判断 deepagents.model 是否已配置。
 */
export function hasDeepagentsModel(value: SessionRuntimeDeepagentsConfig['model']): boolean {
  if (typeof value === 'string') {
    return value.length > 0
  }

  return value !== undefined
}

/**
 * 判断当前运行是否启用了可读取状态的 checkpointer。
 */
export function hasConfiguredDeepagentsCheckpointer(
  value: SessionRuntimeDeepagentsConfig['checkpointer']
): boolean {
  return value !== undefined && value !== false
}
