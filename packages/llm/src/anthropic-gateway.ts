import { anthropic, createAnthropic } from '@ai-sdk/anthropic'

import type { LlmGateway, LlmProviderConfig } from './index.js'
import { SdkLlmGateway } from './sdk-gateway.js'

export function createAnthropicGateway(config: LlmProviderConfig): LlmGateway {
  return new SdkLlmGateway(config, 'anthropic', (providerConfig) => {
    const provider =
      providerConfig.apiKey !== undefined ||
      providerConfig.baseUrl !== undefined ||
      providerConfig.headers !== undefined
        ? createAnthropic({
            apiKey: providerConfig.apiKey,
            baseURL: providerConfig.baseUrl,
            headers: providerConfig.headers,
          })
        : anthropic

    return provider(providerConfig.model)
  })
}
