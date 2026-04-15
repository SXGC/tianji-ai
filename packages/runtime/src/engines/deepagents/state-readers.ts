/**
 * deepagents 状态读取层。
 *
 * 负责从 LangGraph 状态快照中读取运行恢复所需的元数据，包括：
 * - 将 AppMessage 转换为 deepagents 可接受的输入格式（Command.resume 或历史消息）
 * - 从 StateSnapshot 中提取 thread_id、checkpoint_id、interrupt 列表
 * - 校验 interrupt 记录结构
 */
import type { StateSnapshot } from '@langchain/langgraph'
import { Command } from '@langchain/langgraph'
import type { SessionRuntimeDeepagentsConfig } from '../../types.js'

import { isRecord } from './helpers.js'
import { convertAppMessageToDeepagentsMessage } from './message-serialization.js'
import type {
  DeepagentsAgentInstance,
  DeepagentsInterruptRecord,
  ExecuteDeepagentsRunOptions,
} from './types.js'

/**
 * 将一次运行请求转换为 deepagents 可接受的输入。
 * 恢复执行时优先构造 Command.resume；普通执行则把历史消息序列转换为 deepagents messages。
 */
export function readDeepagentsInput(options: ExecuteDeepagentsRunOptions): unknown {
  if (options.resumeValue !== undefined) {
    return new Command({ resume: options.resumeValue })
  }

  return {
    // tool role 消息仅用于快照持久化，不回传给 LangGraph（LangGraph 通过内部状态管理工具调用历史）
    messages: options.messages
      .filter((m) => m.role !== 'tool')
      .map(convertAppMessageToDeepagentsMessage),
  }
}

/**
 * 在启用 checkpointer 时回读 deepagents 状态快照，用于提取 checkpoint 与 interrupt 信息。
 */
export async function maybeReadDeepagentsStateSnapshot(
  agent: DeepagentsAgentInstance,
  options: ExecuteDeepagentsRunOptions,
  threadId: string
): Promise<StateSnapshot | undefined> {
  if (!hasConfiguredDeepagentsCheckpointer(options.deepagents.checkpointer)) {
    return undefined
  }

  return agent.getState({
    configurable: {
      thread_id: threadId,
    },
  })
}

/**
 * 从 LangGraph 状态快照中提取运行恢复所需的 thread_id、checkpoint_id 与 interrupt 列表。
 * 这里会容错 deepagents 返回的松散结构，统一回落到运行时可消费的稳定元数据格式。
 */
export function readDeepagentsStateMetadata(
  snapshot: StateSnapshot,
  fallbackThreadId: string
): {
  readonly threadId: string
  readonly checkpointId?: string
  readonly interrupts: readonly DeepagentsInterruptRecord[]
} {
  const configurable = readConfigurableState(snapshot.config)
  const interrupts = snapshot.tasks.flatMap((task) =>
    task.interrupts
      .filter(isDeepagentsInterruptRecord)
      .map((interrupt) => ({ id: interrupt.id, value: interrupt.value }))
  )

  return {
    threadId:
      typeof configurable?.thread_id === 'string' && configurable.thread_id.length > 0
        ? configurable.thread_id
        : fallbackThreadId,
    checkpointId:
      typeof configurable?.checkpoint_id === 'string' && configurable.checkpoint_id.length > 0
        ? configurable.checkpoint_id
        : undefined,
    interrupts,
  }
}

/**
 * 读取 StateSnapshot.config.configurable；结构不符合预期时返回 undefined。
 */
export function readConfigurableState(
  config: StateSnapshot['config']
): Record<string, unknown> | undefined {
  if (!isRecord(config) || !isRecord(config.configurable)) {
    return undefined
  }

  return config.configurable
}

/**
 * 判断某个 interrupt 记录是否满足 runtime 侧可接受的最小结构。
 */
export function isDeepagentsInterruptRecord(value: unknown): value is DeepagentsInterruptRecord {
  if (!isRecord(value)) {
    return false
  }

  return (
    (value.id === undefined || typeof value.id === 'string') &&
    ('value' in value || value.value === undefined)
  )
}

/**
 * 判断当前运行是否启用了可读取状态的 checkpointer。
 */
function hasConfiguredDeepagentsCheckpointer(
  value: SessionRuntimeDeepagentsConfig['checkpointer']
): boolean {
  return value !== undefined && value !== false
}
