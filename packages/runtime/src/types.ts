/**
 * 共享类型定义。
 *
 * 业务职责：
 * - 集中定义被多个模块引用的接口类型，避免模块间循环依赖。
 *
 * 对外触点：
 * - 被 runtime.ts 和 engines/deepagents-engine.ts 共同引用。
 */
import type { BaseLanguageModel } from '@langchain/core/language_models/base'
import type { InterruptOnConfig } from 'langchain'

export interface RuntimeProviderConfig {
  readonly provider: string
  readonly model: string
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly headers?: Record<string, string>
}

export interface SessionRuntimeDeepagentsConfig {
  readonly model: string | BaseLanguageModel
  readonly providerConfig?: RuntimeProviderConfig
  readonly middleware?: readonly unknown[]
  readonly backend?: unknown
  readonly checkpointer?: unknown
  readonly store?: unknown
  readonly subagents?: readonly { readonly name: string; [key: string]: unknown }[]
  readonly skills?: readonly string[]
  readonly interruptOn?: Record<string, boolean | InterruptOnConfig>
}
