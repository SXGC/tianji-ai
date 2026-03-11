import { createAnthropicGateway } from './anthropic-gateway.js'
import { createGoogleGateway } from './google-gateway.js'
import type { LlmGateway, LlmProviderConfig } from './index.js'
import { createOpenAIGateway } from './openai-gateway.js'

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
