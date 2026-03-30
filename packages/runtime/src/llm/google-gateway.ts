import { createGoogleGenerativeAI, google } from '@ai-sdk/google'

import type { LlmGateway, LlmProviderConfig } from './index.js'
import { SdkLlmGateway } from './sdk-gateway.js'

export function createGoogleGateway(config: LlmProviderConfig): LlmGateway {
  return new SdkLlmGateway(config, 'google', (providerConfig) => {
    const provider =
      providerConfig.apiKey !== undefined ||
      providerConfig.baseUrl !== undefined ||
      providerConfig.headers !== undefined
        ? createGoogleGenerativeAI({
            apiKey: providerConfig.apiKey,
            baseURL: providerConfig.baseUrl,
            headers: providerConfig.headers,
          })
        : google

    return provider(providerConfig.model)
  })
}
