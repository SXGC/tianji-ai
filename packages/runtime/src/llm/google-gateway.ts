import { createGoogleGenerativeAI, google } from '@ai-sdk/google'

import { SdkLlmGateway } from './sdk-gateway.js'
import type { LlmGateway, LlmProviderConfig } from './types.js'

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
