/**
 * session/run metadata 读写、engine 守卫与 deepagents 配置校验。
 *
 * 业务职责：
 * - 统一管理 runtime 在 snapshot metadata 上的读写协议。
 * - 提供 engine 一致性守卫，在 runTurn / resumeRun 路径上早失败。
 * - 提供 deepagents 配置合法性断言，供 SessionRuntimeImpl 构造函数调用。
 *
 * 对外触点：
 * - 被 runtime/session-runtime.ts 和（未来）run-lifecycle.ts 直接引用。
 * - readSessionRuntimeMetadata / readRunRuntimeMetadata / readDeepagentsRunWorkflowState
 *   同时被 runtime.ts barrel re-export 到外部（index.ts 转发）。
 */
import {
  type RunSnapshot,
  type SessionSnapshot,
  TianjiError,
  type TokenUsage,
} from '@tianji/shared'

import type { LlmGenerationConfig } from '../llm/index.js'
import type { SessionRuntimeDeepagentsConfig } from '../types.js'
import type {
  DeepagentsInterruptRecord,
  DeepagentsRunWorkflowState,
  RunRuntimeMetadata,
  SessionRuntimeEngine,
  SessionRuntimeMetadata,
  SessionRuntimeOptions,
} from './types.js'

// ── 内部工具函数 ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isDeepagentsInterruptRecord(value: unknown): value is DeepagentsInterruptRecord {
  if (!isRecord(value)) {
    return false
  }

  return (
    (value.id === undefined || typeof value.id === 'string') &&
    ('value' in value || value.value === undefined)
  )
}

// ── metadata 底层读取 ────────────────────────────────────────────────────────

/**
 * 从 snapshot.metadata 中读取 runtime 子对象，类型安全地返回 Record。
 */
export function readRuntimeMetadataRecord(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const runtime = metadata?.runtime

  if (typeof runtime !== 'object' || runtime === null || Array.isArray(runtime)) {
    return undefined
  }

  return runtime as Record<string, unknown>
}

/**
 * 从 runtime 子对象中读取 engine 字段，仅识别合法值。
 */
export function readRuntimeEngine(
  metadata: Record<string, unknown> | undefined
): SessionRuntimeEngine | undefined {
  const engine = readRuntimeMetadataRecord(metadata)?.engine

  return engine === 'legacy' || engine === 'deepagents' ? engine : undefined
}

/**
 * 从 SessionRuntimeOptions 中读取显式指定的 engine，仅识别合法值。
 */
export function readRequestedEngine(
  options: SessionRuntimeOptions
): SessionRuntimeEngine | undefined {
  const engine = (options as Record<string, unknown>).engine

  return engine === 'legacy' || engine === 'deepagents' ? engine : undefined
}

// ── 公共 metadata 读函数（被 runtime.ts barrel re-export）────────────────────

/**
 * 从 session snapshot metadata 中读取 runtime 信息。
 * 返回 undefined 表示该 snapshot 无 runtime 元数据（例如 legacy 快照）。
 */
export function readSessionRuntimeMetadata(
  metadata: Record<string, unknown> | undefined
): SessionRuntimeMetadata | undefined {
  const engine = readRuntimeEngine(metadata)

  if (engine === undefined) {
    return undefined
  }

  return { engine }
}

/**
 * 从 run snapshot metadata 中读取 runtime 信息（包含 threadId / checkpointId）。
 */
export function readRunRuntimeMetadata(
  metadata: Record<string, unknown> | undefined
): RunRuntimeMetadata | undefined {
  const engine = readRuntimeEngine(metadata)

  if (engine === undefined) {
    return undefined
  }

  const runtime = readRuntimeMetadataRecord(metadata)

  return {
    engine,
    threadId: typeof runtime?.threadId === 'string' ? runtime.threadId : undefined,
    checkpointId: typeof runtime?.checkpointId === 'string' ? runtime.checkpointId : undefined,
  }
}

/**
 * 从 run snapshot workflowState 中读取 deepagents interrupt 状态。
 * 仅识别当前 runtime 约定的 interrupt 快照结构，避免历史脏数据污染恢复流程。
 */
export function readDeepagentsRunWorkflowState(
  workflowState: unknown
): DeepagentsRunWorkflowState | undefined {
  if (!isRecord(workflowState) || workflowState.kind !== 'deepagents-interrupt') {
    return undefined
  }

  if (typeof workflowState.threadId !== 'string') {
    return undefined
  }

  const interrupts = Array.isArray(workflowState.interrupts)
    ? workflowState.interrupts.filter(isDeepagentsInterruptRecord)
    : undefined

  if (interrupts === undefined) {
    return undefined
  }

  return {
    kind: 'deepagents-interrupt',
    threadId: workflowState.threadId,
    checkpointId:
      typeof workflowState.checkpointId === 'string' ? workflowState.checkpointId : undefined,
    interrupts,
  }
}

// ── metadata 写函数 ──────────────────────────────────────────────────────────

/**
 * 将 session 级 runtime 元数据写入 metadata 对象，返回新对象不修改原对象。
 */
export function writeSessionRuntimeMetadata(
  metadata: Record<string, unknown> | undefined,
  runtimeMetadata: SessionRuntimeMetadata
): Record<string, unknown> {
  return {
    ...metadata,
    runtime: {
      ...readRuntimeMetadataRecord(metadata),
      engine: runtimeMetadata.engine,
    },
  }
}

/**
 * 将 run 级 runtime 元数据写入 metadata 对象，返回新对象不修改原对象。
 */
export function writeRunRuntimeMetadata(
  metadata: Record<string, unknown> | undefined,
  runtimeMetadata: RunRuntimeMetadata
): Record<string, unknown> {
  const nextRuntimeMetadata: Record<string, unknown> = {
    ...readRuntimeMetadataRecord(metadata),
    engine: runtimeMetadata.engine,
  }

  if (runtimeMetadata.threadId !== undefined) {
    nextRuntimeMetadata.threadId = runtimeMetadata.threadId
  }

  if (runtimeMetadata.checkpointId !== undefined) {
    nextRuntimeMetadata.checkpointId = runtimeMetadata.checkpointId
  }

  return {
    ...metadata,
    runtime: nextRuntimeMetadata,
  }
}

/**
 * 构造 deepagents interrupt 的工作流状态记录。
 */
export function writeDeepagentsRunWorkflowState(
  state: Omit<DeepagentsRunWorkflowState, 'kind'>
): DeepagentsRunWorkflowState {
  return {
    kind: 'deepagents-interrupt',
    threadId: state.threadId,
    checkpointId: state.checkpointId,
    interrupts: state.interrupts.map((interrupt) => ({
      id: interrupt.id,
      value: interrupt.value,
    })),
  }
}

// ── 辅助 metadata 工具 ───────────────────────────────────────────────────────

/**
 * 合并两个 metadata 对象，后者字段覆盖前者。两者均 undefined 时返回 undefined。
 */
export function mergeMetadata(
  base: Record<string, unknown> | undefined,
  extra: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (base === undefined && extra === undefined) {
    return undefined
  }

  return {
    ...base,
    ...extra,
  }
}

/**
 * 浅克隆 metadata 对象，undefined 原样返回。
 */
export function cloneMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return metadata === undefined ? undefined : { ...metadata }
}

// ── engine 守卫 ──────────────────────────────────────────────────────────────

/**
 * 断言 session 未关闭，closedAt 字段存在则抛出 TianjiError。
 */
export function ensureSessionOpen(snapshot: SessionSnapshot): void {
  if (snapshot.metadata?.closedAt !== undefined) {
    throw new TianjiError(
      'state',
      'SESSION_CLOSED',
      `Session "${snapshot.sessionId}" has been closed`
    )
  }
}

/**
 * 断言 session 绑定的 engine 与当前 runtime engine 一致。
 */
export function ensureSessionEngineMatches(
  snapshot: SessionSnapshot,
  expectedEngine: SessionRuntimeEngine
): void {
  const storedEngine = readSessionRuntimeMetadata(snapshot.metadata)?.engine ?? 'legacy'

  if (storedEngine !== expectedEngine) {
    throw new TianjiError(
      'state',
      'SESSION_ENGINE_MISMATCH',
      `Session "${snapshot.sessionId}" is bound to runtime engine "${storedEngine}", but the current runtime is using "${expectedEngine}"`
    )
  }
}

/**
 * 断言 run 绑定的 engine 与当前 runtime engine 一致。
 */
export function ensureRunEngineMatches(
  snapshot: RunSnapshot,
  expectedEngine: SessionRuntimeEngine
): void {
  const storedEngine = readRunRuntimeMetadata(snapshot.metadata)?.engine ?? 'legacy'

  if (storedEngine === expectedEngine) {
    return
  }

  throw new TianjiError(
    'state',
    'SESSION_ENGINE_MISMATCH',
    `Run "${snapshot.runId}" is bound to runtime engine "${storedEngine}", but the current runtime is using "${expectedEngine}"`
  )
}

// ── 存储辅助读函数 ────────────────────────────────────────────────────────────

/**
 * 从 run metadata 中读取保存的系统提示，类型不匹配时返回 undefined。
 */
export function readStoredSystemPrompt(
  metadata: Record<string, unknown> | undefined
): string | undefined {
  const systemPrompt = metadata?.systemPrompt
  return typeof systemPrompt === 'string' ? systemPrompt : undefined
}

/**
 * 从 run metadata 中读取保存的生成配置，类型不匹配时返回 undefined。
 */
export function readStoredGenerationConfig(
  metadata: Record<string, unknown> | undefined
): LlmGenerationConfig | undefined {
  const config = metadata?.generationConfig
  return typeof config === 'object' && config !== null ? (config as LlmGenerationConfig) : undefined
}

// ── deepagents 配置守卫 ──────────────────────────────────────────────────────

/**
 * 检查 deepagents 配置中是否提供了有效的模型配置。
 */
export function hasConfiguredDeepagentsModel(
  deepagents: SessionRuntimeOptions['deepagents']
): deepagents is SessionRuntimeDeepagentsConfig {
  if (deepagents === undefined) {
    return false
  }

  if (typeof deepagents.model === 'string') {
    return deepagents.model.length > 0
  }

  return deepagents.model !== undefined
}

/**
 * 检查 deepagents 配置中是否声明了 interruptOn（需要 checkpointer 配合）。
 */
export function hasInterruptConfiguration(
  deepagents: SessionRuntimeDeepagentsConfig | undefined
): boolean {
  return deepagents?.interruptOn !== undefined && Object.keys(deepagents.interruptOn).length > 0
}

/**
 * 检查 deepagents 配置中是否提供了有效的 checkpointer。
 */
export function hasConfiguredDeepagentsCheckpointer(
  deepagents: SessionRuntimeDeepagentsConfig | undefined
): boolean {
  return deepagents?.checkpointer !== undefined && deepagents.checkpointer !== false
}

// ── usage 读取 ───────────────────────────────────────────────────────────────

/**
 * 从 metadata 中安全读取 TokenUsage，类型不匹配时返回 undefined。
 */
export function readTokenUsage(
  metadata: Record<string, unknown> | undefined
): TokenUsage | undefined {
  const usage = metadata?.usage

  if (typeof usage !== 'object' || usage === null) {
    return undefined
  }

  const candidate = usage as {
    inputTokens?: unknown
    outputTokens?: unknown
    totalTokens?: unknown
    cacheReadTokens?: unknown
    cacheCreationTokens?: unknown
  }

  if (
    typeof candidate.inputTokens !== 'number' ||
    typeof candidate.outputTokens !== 'number' ||
    typeof candidate.totalTokens !== 'number'
  ) {
    return undefined
  }

  const cacheRead =
    typeof candidate.cacheReadTokens === 'number' ? candidate.cacheReadTokens : undefined
  const cacheCreation =
    typeof candidate.cacheCreationTokens === 'number' ? candidate.cacheCreationTokens : undefined

  return {
    inputTokens: candidate.inputTokens,
    outputTokens: candidate.outputTokens,
    totalTokens: candidate.totalTokens,
    ...(cacheRead !== undefined && { cacheReadTokens: cacheRead }),
    ...(cacheCreation !== undefined && { cacheCreationTokens: cacheCreation }),
  }
}
