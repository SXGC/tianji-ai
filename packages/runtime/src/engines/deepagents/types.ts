/**
 * deepagents 引擎内部类型定义。
 *
 * 该模块仅供 engines/deepagents-engine.ts 及其子模块使用，不对外导出。
 */
import type { StateSnapshot } from '@langchain/langgraph'
import type {
  AppMessage,
  DomainEvent,
  ExecutionPolicy,
  RunId,
  RunSnapshot,
  SessionId,
  TokenUsage,
  ToolInvocation,
} from '@tianji/shared'

import type { ObserverLogger } from '@tianji/observer'
import type { LlmGenerationConfig } from '../../llm/index.js'
import type { ToolCatalog } from '../../tool-catalog.js'
import type { SessionRuntimeDeepagentsConfig } from '../../types.js'

export interface DeepagentsPendingToolCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly argsText: string
  readonly args: unknown
  consumed: boolean
}

export interface ExecuteDeepagentsRunOptions {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly messages: readonly AppMessage[]
  readonly signal: AbortSignal
  readonly policy: ExecutionPolicy
  readonly config?: LlmGenerationConfig
  readonly systemPrompt?: string
  readonly threadId?: string
  readonly checkpointId?: string
  readonly resumeValue?: unknown
  readonly deepagents: SessionRuntimeDeepagentsConfig
  readonly toolCatalog: ToolCatalog
  readonly pendingOperations: Map<string, RunSnapshot['pendingOperations'][number]>
  readonly destructiveOperationIds: Set<string>
  readonly sequence: {
    current: number
  }
  readonly llmRawDir?: string
  readonly logger?: ObserverLogger
  readonly emitEvent: (event: DomainEvent) => void
}

export type DeepAgentFactory = (params?: Record<string, unknown>) => DeepagentsAgentInstance

export interface DeepagentsAgentEvent {
  readonly event: string
  readonly name: string
  readonly run_id: string
  readonly data?: Record<string, unknown>
}

export interface DeepagentsAgentInstance {
  readonly streamEvents: (
    input: unknown,
    options: {
      readonly version: 'v2'
      readonly configurable: {
        readonly thread_id: string
        readonly checkpoint_id?: string
      }
      readonly signal: AbortSignal
    }
  ) => Promise<AsyncIterable<DeepagentsAgentEvent>>
  readonly getState: (options: {
    readonly configurable: {
      readonly thread_id: string
      readonly checkpoint_id?: string
    }
  }) => Promise<StateSnapshot>
}

export interface DeepagentsInterruptRecord {
  readonly id?: string
  readonly value?: unknown
}

export interface DeepagentsRunResult {
  readonly turnMessages: AppMessage[]
  readonly threadId: string
  readonly checkpointId?: string
  readonly interrupts?: readonly DeepagentsInterruptRecord[]
  readonly usage?: TokenUsage
}

export interface AbortSignalScope {
  readonly signal: AbortSignal | undefined
  readonly cleanup: () => void
}

/** 事件循环中共享的可变状态。 */
export interface StreamLoopState {
  readonly messageId: string
  readonly messageStartedAt: number
  readonly observedToolCalls: DeepagentsPendingToolCall[]
  readonly turnMessages: AppMessage[]
  readonly builtinToolInvocations: Map<string, ToolInvocation>
  currentThinking: string
  currentText: string
  usage: TokenUsage | undefined
}
