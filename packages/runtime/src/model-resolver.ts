/**
 * Agent 模型引用解析工具。
 *
 * 业务职责：
 * - 把 tianji.config.json 中的 `provider/modelName` 引用映射为 deepagents 可直接消费的模型值。
 * - 对自定义 OpenAI 兼容端点预先实例化 ChatOpenAI，避免 deepagents 内部 `initChatModel`
 *   无法转发 `baseUrl`/`apiKey` 的限制（deepagents@1.8.4 中 `initChatModel(model)`
 *   仅传入 model 字符串，不接收 provider 级参数）。
 *
 * 对外触点：
 * - 被 apps/node daemon-entry 与 @tianji/agent acp-entry 用于构造 executor 的
 *   `resolveModel` 回调。
 * - 与 runtime.ts 中的内部 `resolveDeepagentsModel` 语义对齐，但后者针对已经展开的
 *   `RuntimeProviderConfig`，本模块面向原始 `TianjiProvidersConfig`。
 */
import type { BaseLanguageModel } from '@langchain/core/language_models/base'
import { ChatOpenAI } from '@langchain/openai'
import {
  type TianjiProviderConfig,
  type TianjiProvidersConfig,
  parseAgentModelRef,
} from '@tianji/shared'

/**
 * 将 `provider/modelName` 形式的配置引用解析为 deepagents 可直接消费的模型值。
 *
 * @param modelRef - tianji.config.json 中 `agents.items.<name>.model` 的值
 * @param providers - tianji.config.json 中 `providers` 字段对应的映射
 * @returns 形如 `provider:modelName` 的 LangChain 前缀字符串；或当 provider 配置了
 *          自定义 baseUrl/headers 时返回预实例化的模型对象
 */
export function resolveAgentModel(
  modelRef: string,
  providers: TianjiProvidersConfig | undefined
): string | BaseLanguageModel {
  const { provider, modelName } = parseAgentModelRef(modelRef)
  const providerConfig = providers?.[provider]
  const baseUrl = readProviderStringField(providerConfig, 'baseUrl')
  const headers = readProviderHeaderRecord(providerConfig)

  // 仅 OpenAI 官方 SDK 支持通过 configuration 注入自定义 baseURL；其他 provider
  // 若未来需要支持自定义端点应在此处按 provider 扩展分派。
  if (provider === 'openai' && (baseUrl !== undefined || headers !== undefined)) {
    return new ChatOpenAI({
      model: modelName,
      apiKey: providerConfig?.apiKey,
      configuration: {
        baseURL: baseUrl,
        defaultHeaders: headers,
      },
    })
  }

  return `${provider}:${modelName}`
}

/** 从 passthrough provider 配置中读取指定 string 字段，非字符串返回 undefined。 */
function readProviderStringField(
  providerConfig: TianjiProviderConfig | undefined,
  field: string
): string | undefined {
  const value = (providerConfig as Record<string, unknown> | undefined)?.[field]
  return typeof value === 'string' ? value : undefined
}

/** 从 passthrough provider 配置中提取合法的 headers 映射（仅保留 string value）。 */
function readProviderHeaderRecord(
  providerConfig: TianjiProviderConfig | undefined
): Record<string, string> | undefined {
  const raw = (providerConfig as Record<string, unknown> | undefined)?.headers
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return undefined
  }
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}
