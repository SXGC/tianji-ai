/**
 * deepagents 工具适配层。
 *
 * 负责将运行时 ToolCatalog 中的工具包装为 deepagents 可调用的 DynamicStructuredTool，
 * 并将 deepagents 工具调用结果映射回平台侧事件协议：
 * - createDeepagentsTools：将 ToolCatalog 工具转为 deepagents tool 数组
 * - executeDeepagentsToolCall：执行单次工具调用并同步状态与事件
 * - resolveToolCallId：优先复用模型侧观测到的 toolCallId
 */
import { randomUUID } from 'node:crypto'

import { DynamicStructuredTool } from '@langchain/core/tools'
import { type AppMessage, CancelledError, type ToolInvocation } from '@tianji/shared'
import { ToolError } from '@tianji/shared'

import { ensureToolAllowed } from '../../tool-catalog.js'
import {
  executeWithTimeout,
  isCancellationError,
  resolveToolError,
  stableSerialize,
  toError,
} from './helpers.js'
import type { DeepagentsPendingToolCall, ExecuteDeepagentsRunOptions } from './types.js'

/**
 * 根据运行时工具目录创建 deepagents 工具列表。
 * 每个 deepagents tool 最终都会回流到 runtime 的 executeTool 流程，以复用统一的权限、超时、取消和事件分发逻辑。
 */
export function createDeepagentsTools(
  options: ExecuteDeepagentsRunOptions,
  observedToolCalls: DeepagentsPendingToolCall[],
  turnMessages: AppMessage[]
): DynamicStructuredTool[] {
  return options.toolCatalog.getToolSpecs().map(
    (spec) =>
      new DynamicStructuredTool({
        name: spec.name,
        description: spec.description,
        schema: spec.parameters,
        func: async (args) =>
          executeDeepagentsToolCall(options, observedToolCalls, turnMessages, {
            toolName: spec.name,
            args,
          }),
      })
  )
}

/**
 * 执行一次来自 deepagents 的工具调用，并把运行时事件、挂起状态与错误语义同步到平台侧。
 *
 * 关键职责：
 * - 校验工具是否存在且是否允许执行破坏性操作。
 * - 结合模型流式观测结果复用 toolCallId，保证事件与快照中的工具调用可关联。
 * - 在统一超时/取消控制下执行工具，并维护 pendingOperations 的状态迁移。
 * - 将原始错误归一化为 contracts 中定义的 ToolError / CancelledError / TimeoutError。
 */
export async function executeDeepagentsToolCall(
  options: ExecuteDeepagentsRunOptions,
  observedToolCalls: DeepagentsPendingToolCall[],
  turnMessages: AppMessage[],
  input: {
    readonly toolName: string
    readonly args: unknown
  }
): Promise<unknown> {
  // 先从运行时工具目录解析定义，保证 deepagents 工具调用仍受平台侧策略和上下文控制。
  const definition = options.toolCatalog.getTool(input.toolName)

  if (definition === undefined) {
    throw new ToolError('TOOL_NOT_FOUND', `Tool "${input.toolName}" is not registered`)
  }

  ensureToolAllowed(definition, options.policy.tool.allowDestructive)

  const toolCallId = resolveToolCallId(observedToolCalls, input.toolName, input.args)
  const invocation: ToolInvocation = {
    toolCallId,
    toolName: input.toolName,
    args: input.args,
  }
  const timestamp = Date.now()

  options.emitEvent({
    type: 'ToolStarted',
    runId: options.runId,
    toolCallId,
    invocation,
    timestamp,
  })

  options.pendingOperations.set(toolCallId, {
    id: toolCallId,
    invocation,
    status: 'running',
    timestamp,
  })

  try {
    const result = await executeWithTimeout(
      (abortSignal) =>
        options.toolCatalog.executeTool(invocation, {
          sessionId: options.sessionId,
          runId: options.runId,
          toolCallId,
          abortSignal,
        }),
      options.policy.tool.timeoutMs,
      options.signal
    )
    options.pendingOperations.set(toolCallId, {
      id: toolCallId,
      invocation,
      status: 'completed',
      timestamp,
    })

    if (definition.sideEffect === 'destructive') {
      options.destructiveOperationIds.add(toolCallId)
    }

    turnMessages.push({
      id: `msg_${randomUUID()}`,
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: input.toolName,
          result,
          isError: false,
        },
      ],
      createdAt: Date.now(),
    })

    options.emitEvent({
      type: 'ToolCompleted',
      runId: options.runId,
      toolCallId,
      invocation,
      result: { toolCallId, result },
      timestamp: Date.now(),
    })

    return result
  } catch (error) {
    if (isCancellationError(error, options.signal)) {
      options.pendingOperations.set(toolCallId, {
        id: toolCallId,
        invocation,
        status:
          definition.sideEffect === 'destructive' ? 'aborted-with-side-effect' : 'aborted-clean',
        timestamp,
      })
      throw new CancelledError('RUN_CANCELLED', 'Run cancelled during tool execution', {
        cause: toError(error),
      })
    }

    const resolvedError = resolveToolError(error)

    options.pendingOperations.set(toolCallId, {
      id: toolCallId,
      invocation,
      status:
        definition.sideEffect === 'destructive' ? 'aborted-with-side-effect' : 'aborted-clean',
      timestamp,
    })
    turnMessages.push({
      id: `msg_${randomUUID()}`,
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: input.toolName,
          result: resolvedError.message,
          isError: true,
        },
      ],
      createdAt: Date.now(),
    })

    options.emitEvent({
      type: 'ToolFailed',
      runId: options.runId,
      toolCallId,
      invocation,
      error: resolvedError,
      timestamp: Date.now(),
    })
    throw resolvedError
  }
}

/**
 * 优先复用模型侧已观测到的 toolCallId；匹配失败时退化为生成本地 ID。
 */
export function resolveToolCallId(
  observedToolCalls: DeepagentsPendingToolCall[],
  toolName: string,
  args: unknown
): string {
  const comparableArgs = stableSerialize(args)
  const matched = observedToolCalls.find(
    (toolCall) =>
      !toolCall.consumed &&
      toolCall.toolName === toolName &&
      stableSerialize(toolCall.args) === comparableArgs
  )

  if (matched !== undefined) {
    matched.consumed = true
    return matched.toolCallId
  }

  return `tool_${randomUUID()}`
}
