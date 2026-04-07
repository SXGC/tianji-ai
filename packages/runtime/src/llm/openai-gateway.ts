import { createOpenAI, openai } from '@ai-sdk/openai'

import { SdkLlmGateway } from './sdk-gateway.js'
import type { LlmGateway, LlmProviderConfig } from './types.js'

export function createOpenAIGateway(config: LlmProviderConfig): LlmGateway {
  return new SdkLlmGateway(config, 'openai', (providerConfig) => {
    const provider =
      providerConfig.apiKey !== undefined ||
      providerConfig.baseUrl !== undefined ||
      providerConfig.headers !== undefined
        ? createOpenAI({
            apiKey: providerConfig.apiKey,
            baseURL: providerConfig.baseUrl,
            headers: providerConfig.headers,
          })
        : openai

    return provider(providerConfig.model)
  })
}
