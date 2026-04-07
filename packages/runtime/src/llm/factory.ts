import { createAnthropicGateway } from './anthropic-gateway.js'
import { createGoogleGateway } from './google-gateway.js'
import { createOpenAIGateway } from './openai-gateway.js'
import type { LlmGateway, LlmProviderConfig } from './types.js'

export function createLlmGateway(config: LlmProviderConfig): LlmGateway {
  switch (config.provider) {
    case 'openai':
      return createOpenAIGateway(config)
    case 'anthropic':
      return createAnthropicGateway(config)
    case 'google':
      return createGoogleGateway(config)
  }
}
