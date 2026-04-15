/**
 * run 生命周期处理器（纯函数形式）。
 *
 * 业务职责：
 * - 处理 run 的各种终止路径：正常完成、HITL 中断、取消、失败。
 * - 处理 run 生命周期的 observer 日志记录（run / tool / message）。
 *
 * 对外触点：
 * - 被 runtime/session-runtime.ts（SessionRuntimeImpl.executeRun）调用。
 * - 不对外 re-export，均为内部符号。
 */
import type { ObserverLogger } from '@tianji/observer'
import {
  type MessageCompletedEvent,
  ProviderError,
  type RunSnapshot,
  type SessionSnapshot,
  type TokenUsage,
  type ToolCompletedEvent,
  type ToolFailedEvent,
  type ToolStartedEvent,
  addTokenUsage,
} from '@tianji/shared'

import type { DeepagentsRunResult } from '../engines/deepagents-engine.js'
import type { SnapshotStore } from '../snapshot-store.js'
import { hasSideEffect, toTianjiError } from './helpers.js'
import {
  mergeMetadata,
  readTokenUsage,
  writeDeepagentsRunWorkflowState,
  writeRunRuntimeMetadata,
} from './metadata.js'
import type {
  ActiveRun,
  ExecuteRunInput,
  RunExecutionContext,
  RunLineageFields,
  SessionRuntimeEngine,
} from './types.js'

// ── 依赖容器 ──────────────────────────────────────────────────────────────────

export interface RunLifecycleDeps {
  readonly snapshotStore: SnapshotStore
  readonly logger: ObserverLogger | undefined
  readonly engine: SessionRuntimeEngine
}

// ── 生命周期处理器 ────────────────────────────────────────────────────────────

/**
 * 处理 run 成功完成路径：包含 HITL 中断映射和正常完成两种情况。
 */
export async function handleRunSuccess(
  deps: RunLifecycleDeps,
  activeRun: ActiveRun,
  runSnapshot: RunSnapshot,
  input: ExecuteRunInput,
  context: RunExecutionContext,
  lineage: RunLineageFields,
  result: DeepagentsRunResult
): Promise<void> {
  const completedRunMetadata = writeRunRuntimeMetadata(runSnapshot.metadata, {
    engine: deps.engine,
    threadId: result.threadId,
    checkpointId: result.checkpointId,
  })

  // 将 run 级别的 token 用量写入 metadata，供查询和日志使用。
  const runMetadataWithUsage =
    result.usage === undefined
      ? completedRunMetadata
      : { ...completedRunMetadata, usage: result.usage }

  if (result.interrupts !== undefined && result.interrupts.length > 0) {
    await handleHitlInterrupt(
      deps,
      activeRun,
      runSnapshot,
      context,
      lineage,
      result,
      runMetadataWithUsage
    )
    return
  }

  await handleRunCompletion(
    deps,
    activeRun,
    runSnapshot,
    input,
    context,
    lineage,
    result,
    runMetadataWithUsage
  )
}

/**
 * 处理 deepagents HITL 中断：将 run 标记为 cancelled 并持久化恢复所需 checkpoint/interrupt 信息。
 */
export async function handleHitlInterrupt(
  deps: RunLifecycleDeps,
  activeRun: ActiveRun,
  runSnapshot: RunSnapshot,
  context: RunExecutionContext,
  lineage: RunLineageFields,
  result: DeepagentsRunResult,
  runMetadataWithUsage: Record<string, unknown>
): Promise<void> {
  const interruptedRunSnapshot: RunSnapshot = {
    ...runSnapshot,
    status: 'cancelled',
    updatedAt: Date.now(),
    cancelPoint: 'human-in-the-loop',
    pendingOperations: [...context.pendingOperations.values()],
    resumeHint: 'require-user-confirmation',
    workflowState: writeDeepagentsRunWorkflowState({
      threadId: result.threadId,
      checkpointId: result.checkpointId,
      interrupts: result.interrupts ?? [],
    }),
    metadata: runMetadataWithUsage,
  }

  await deps.snapshotStore.saveRun(interruptedRunSnapshot)

  activeRun.events.push({
    type: 'RunCancelled',
    ...lineage,
    reason: 'hitl',
    timestamp: Date.now(),
  })
  logRunLifecycle(deps.logger, 'info', 'run.cancelled', lineage, {
    cancelPoint: 'human-in-the-loop',
    ...(result.usage === undefined ? undefined : { usage: result.usage }),
  })
  activeRun.events.close()
}

/**
 * 处理 run 正常完成：更新 session 快照并保存 completed run 快照。
 */
export async function handleRunCompletion(
  deps: RunLifecycleDeps,
  activeRun: ActiveRun,
  runSnapshot: RunSnapshot,
  input: ExecuteRunInput,
  context: RunExecutionContext,
  lineage: RunLineageFields,
  result: DeepagentsRunResult,
  runMetadataWithUsage: Record<string, unknown>
): Promise<void> {
  if (result.turnMessages.length === 0) {
    throw new ProviderError('RUN_EMPTY_RESPONSE', 'Runtime workflow finished without any messages')
  }

  // 将本次 run 的 token 用量累加到 session 级别。
  const sessionMetadataWithUsage =
    result.usage === undefined
      ? input.sessionSnapshot.metadata
      : {
          ...input.sessionSnapshot.metadata,
          usage: addTokenUsage(readTokenUsage(input.sessionSnapshot.metadata), result.usage),
        }

  const nextSessionSnapshot: SessionSnapshot = {
    ...input.sessionSnapshot,
    messages: [...input.sessionSnapshot.messages, ...result.turnMessages],
    updatedAt: Date.now(),
    metadata: sessionMetadataWithUsage,
  }
  const completedRunSnapshot: RunSnapshot = {
    ...runSnapshot,
    status: 'completed',
    messages: nextSessionSnapshot.messages,
    updatedAt: Date.now(),
    pendingOperations: [...context.pendingOperations.values()],
    metadata: runMetadataWithUsage,
  }

  await deps.snapshotStore.saveSession(nextSessionSnapshot)
  await deps.snapshotStore.saveRun(completedRunSnapshot)

  activeRun.events.push({
    type: 'RunCompleted',
    ...lineage,
    timestamp: Date.now(),
  })
  logRunLifecycle(deps.logger, 'info', 'run.completed', lineage, {
    ...(result.usage === undefined ? undefined : { usage: result.usage }),
  })
  activeRun.events.close()
}

/**
 * 处理 run 被取消（AbortSignal 触发）：保存 cancelled 快照并关闭事件流。
 */
export async function handleRunCancellation(
  deps: RunLifecycleDeps,
  activeRun: ActiveRun,
  runSnapshot: RunSnapshot,
  context: RunExecutionContext,
  lineage: RunLineageFields,
  capturedUsage: TokenUsage | undefined
): Promise<void> {
  const cancelledRunSnapshot: RunSnapshot = {
    ...runSnapshot,
    status: 'cancelled',
    updatedAt: Date.now(),
    cancelPoint: 'assistant_turn',
    pendingOperations: [...context.pendingOperations.values()],
    resumeHint: hasSideEffect(context.pendingOperations, context.destructiveOperationIds)
      ? 'require-user-confirmation'
      : 'replay',
    metadata:
      capturedUsage === undefined
        ? runSnapshot.metadata
        : { ...runSnapshot.metadata, usage: capturedUsage },
  }

  await deps.snapshotStore.saveRun(cancelledRunSnapshot)

  activeRun.events.push({
    type: 'RunCancelled',
    ...lineage,
    reason: 'abort',
    timestamp: Date.now(),
  })
  logRunLifecycle(deps.logger, 'warn', 'run.cancelled', lineage, {
    ...(capturedUsage === undefined ? undefined : { usage: capturedUsage }),
  })
  activeRun.events.close()
}

/**
 * 处理 run 执行失败（非取消错误）：保存 failed 快照并将错误传播到事件流。
 */
export async function handleRunFailure(
  deps: RunLifecycleDeps,
  activeRun: ActiveRun,
  runSnapshot: RunSnapshot,
  context: RunExecutionContext,
  lineage: RunLineageFields,
  error: unknown,
  capturedUsage: TokenUsage | undefined
): Promise<void> {
  const resolvedError = toTianjiError(error)
  const failedRunSnapshot: RunSnapshot = {
    ...runSnapshot,
    status: 'failed',
    updatedAt: Date.now(),
    pendingOperations: [...context.pendingOperations.values()],
    metadata: mergeMetadata(runSnapshot.metadata, {
      failureCode: resolvedError.code,
      ...(capturedUsage === undefined ? undefined : { usage: capturedUsage }),
    }),
  }

  await deps.snapshotStore.saveRun(failedRunSnapshot)

  activeRun.events.push({
    type: 'RunFailed',
    ...lineage,
    error: resolvedError,
    timestamp: Date.now(),
  })
  logRunLifecycle(deps.logger, 'error', 'run.failed', lineage, {
    errorCode: resolvedError.code,
  })
  activeRun.events.fail(resolvedError)
}

// ── 日志函数 ──────────────────────────────────────────────────────────────────

/**
 * 统一输出 run 生命周期 observer 日志，确保链路标识只在一个位置组装。
 */
export function logRunLifecycle(
  logger: ObserverLogger | undefined,
  level: 'info' | 'warn' | 'error',
  message: 'run.started' | 'run.completed' | 'run.failed' | 'run.cancelled',
  fields: RunLineageFields,
  extraData?: Record<string, unknown>
): void {
  if (logger === undefined) {
    return
  }

  const data: Record<string, unknown> = {
    sessionId: fields.sessionId,
    runId: fields.runId,
    triggerType: fields.triggerType,
    ...extraData,
  }

  if (fields.parentRunId !== undefined) {
    data.parentRunId = fields.parentRunId
  }

  void logger[level](['runtime', 'run'], message, data)
}

/**
 * 将工具事件写入 observer logger，scope 为 ['runtime', 'tool']。
 * runtime 层记录所有 session 的工具事件，与 TaskExecutor 层的单任务摘要日志互补。
 */
export function logToolEvent(
  logger: ObserverLogger | undefined,
  event: ToolStartedEvent | ToolCompletedEvent | ToolFailedEvent,
  fields: RunLineageFields
): void {
  if (logger === undefined) {
    return
  }

  if (event.type === 'ToolStarted') {
    void logger.info(['runtime', 'tool'], 'tool.started', {
      sessionId: fields.sessionId,
      runId: fields.runId,
      toolCallId: event.toolCallId,
      toolName: event.invocation.toolName,
      args: event.invocation.args,
    })
  } else if (event.type === 'ToolCompleted') {
    void logger.info(['runtime', 'tool'], 'tool.completed', {
      sessionId: fields.sessionId,
      runId: fields.runId,
      toolCallId: event.toolCallId,
      toolName: event.invocation.toolName,
      result: event.result.result,
    })
  } else {
    void logger.error(['runtime', 'tool'], 'tool.failed', {
      sessionId: fields.sessionId,
      runId: fields.runId,
      toolCallId: event.toolCallId,
      toolName: event.invocation.toolName,
      args: event.invocation.args,
      errorCode: event.error.code,
      errorMessage: event.error.message,
    })
  }
}

/**
 * 将 message.completed 事件写入 observer logger，scope 为 ['runtime', 'message']。
 * 记录消息摘要，包含 thinking/tool-call 标记与文本预览。
 */
export function logMessageEvent(
  logger: ObserverLogger | undefined,
  event: MessageCompletedEvent,
  fields: RunLineageFields
): void {
  if (logger === undefined) {
    return
  }

  const hasThinking = event.message.content.some((p) => p.type === 'thinking')
  const hasToolCalls = event.message.content.some((p) => p.type === 'tool-call')
  const textParts = event.message.content
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)

  void logger.info(['runtime', 'message'], 'MessageCompleted', {
    sessionId: fields.sessionId,
    runId: fields.runId,
    messageId: event.messageId,
    role: event.message.role,
    hasThinking,
    hasToolCalls,
    textPreview: textParts.join('').slice(0, 200),
  })
}
