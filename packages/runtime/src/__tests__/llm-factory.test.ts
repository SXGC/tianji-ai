import { describe, expect, it, vi } from 'vitest'

import type { LlmProviderConfig } from '../llm/index.js'

// ---------------------------------------------------------------------------
// Mock the three gateway creators
// ---------------------------------------------------------------------------

vi.mock('../llm/openai-gateway.js', () => ({
  createOpenAIGateway: vi.fn(() => ({ _type: 'openai-gateway' })),
}))

vi.mock('../llm/anthropic-gateway.js', () => ({
  createAnthropicGateway: vi.fn(() => ({ _type: 'anthropic-gateway' })),
}))

vi.mock('../llm/google-gateway.js', () => ({
  createGoogleGateway: vi.fn(() => ({ _type: 'google-gateway' })),
}))

const { createOpenAIGateway } = await import('../llm/openai-gateway.js')
const { createAnthropicGateway } = await import('../llm/anthropic-gateway.js')
const { createGoogleGateway } = await import('../llm/google-gateway.js')
const { createLlmGateway } = await import('../llm/factory.js')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createLlmGateway', () => {
  it('creates OpenAI gateway for provider "openai"', () => {
    const config: LlmProviderConfig = { provider: 'openai', model: 'gpt-4' }
    const result = createLlmGateway(config)

    expect(createOpenAIGateway).toHaveBeenCalledWith(config)
    expect(result).toEqual({ _type: 'openai-gateway' })
  })

  it('creates Anthropic gateway for provider "anthropic"', () => {
    const config: LlmProviderConfig = { provider: 'anthropic', model: 'claude-3-opus' }
    const result = createLlmGateway(config)

    expect(createAnthropicGateway).toHaveBeenCalledWith(config)
    expect(result).toEqual({ _type: 'anthropic-gateway' })
  })

  it('creates Google gateway for provider "google"', () => {
    const config: LlmProviderConfig = { provider: 'google', model: 'gemini-pro' }
    const result = createLlmGateway(config)

    expect(createGoogleGateway).toHaveBeenCalledWith(config)
    expect(result).toEqual({ _type: 'google-gateway' })
  })
})
