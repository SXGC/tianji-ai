import { describe, expect, it, vi } from 'vitest'

import type { LlmProviderConfig } from '../llm/index.js'
import { SdkLlmGateway } from '../llm/sdk-gateway.js'

// ---------------------------------------------------------------------------
// Mock provider SDK modules
// ---------------------------------------------------------------------------

const mockOpenAIModel = { modelId: 'openai-model', specificationVersion: 'v1' }
const mockOpenAIProvider = vi.fn(() => mockOpenAIModel)
const mockCreateOpenAI = vi.fn(() => mockOpenAIProvider)

vi.mock('@ai-sdk/openai', () => ({
  openai: Object.assign(
    vi.fn(() => mockOpenAIModel),
    { _default: true }
  ),
  createOpenAI: mockCreateOpenAI,
}))

const mockAnthropicModel = { modelId: 'anthropic-model', specificationVersion: 'v1' }
const mockAnthropicProvider = vi.fn(() => mockAnthropicModel)
const mockCreateAnthropic = vi.fn(() => mockAnthropicProvider)

vi.mock('@ai-sdk/anthropic', () => ({
  anthropic: Object.assign(
    vi.fn(() => mockAnthropicModel),
    { _default: true }
  ),
  createAnthropic: mockCreateAnthropic,
}))

const mockGoogleModel = { modelId: 'google-model', specificationVersion: 'v1' }
const mockGoogleProvider = vi.fn(() => mockGoogleModel)
const mockCreateGoogle = vi.fn(() => mockGoogleProvider)

vi.mock('@ai-sdk/google', () => ({
  google: Object.assign(
    vi.fn(() => mockGoogleModel),
    { _default: true }
  ),
  createGoogleGenerativeAI: mockCreateGoogle,
}))

const { createOpenAIGateway } = await import('../llm/openai-gateway.js')
const { createAnthropicGateway } = await import('../llm/anthropic-gateway.js')
const { createGoogleGateway } = await import('../llm/google-gateway.js')

// ---------------------------------------------------------------------------
// OpenAI Gateway
// ---------------------------------------------------------------------------

describe('createOpenAIGateway', () => {
  it('uses default provider when no custom config', () => {
    const config: LlmProviderConfig = { provider: 'openai', model: 'gpt-4' }
    const gw = createOpenAIGateway(config)

    expect(gw).toBeInstanceOf(SdkLlmGateway)
    expect(gw.getProviderInfo()).toEqual({ provider: 'openai', model: 'gpt-4' })
  })

  it('uses createOpenAI factory when apiKey is provided', () => {
    const config: LlmProviderConfig = {
      provider: 'openai',
      model: 'gpt-4',
      apiKey: 'sk-test',
    }
    const gw = createOpenAIGateway(config)

    expect(gw).toBeInstanceOf(SdkLlmGateway)
  })

  it('uses createOpenAI factory when baseUrl is provided', () => {
    const config: LlmProviderConfig = {
      provider: 'openai',
      model: 'gpt-4',
      baseUrl: 'https://proxy.example.com',
    }
    const gw = createOpenAIGateway(config)

    expect(gw).toBeInstanceOf(SdkLlmGateway)
  })

  it('uses createOpenAI factory when headers are provided', () => {
    const config: LlmProviderConfig = {
      provider: 'openai',
      model: 'gpt-4',
      headers: { 'x-custom': 'value' },
    }
    const gw = createOpenAIGateway(config)

    expect(gw).toBeInstanceOf(SdkLlmGateway)
  })
})

// ---------------------------------------------------------------------------
// Anthropic Gateway
// ---------------------------------------------------------------------------

describe('createAnthropicGateway', () => {
  it('uses default provider when no custom config', () => {
    const config: LlmProviderConfig = { provider: 'anthropic', model: 'claude-3-opus' }
    const gw = createAnthropicGateway(config)

    expect(gw).toBeInstanceOf(SdkLlmGateway)
    expect(gw.getProviderInfo()).toEqual({ provider: 'anthropic', model: 'claude-3-opus' })
  })

  it('uses createAnthropic factory when apiKey is provided', () => {
    const config: LlmProviderConfig = {
      provider: 'anthropic',
      model: 'claude-3-opus',
      apiKey: 'sk-ant-test',
    }
    const gw = createAnthropicGateway(config)

    expect(gw).toBeInstanceOf(SdkLlmGateway)
  })
})

// ---------------------------------------------------------------------------
// Google Gateway
// ---------------------------------------------------------------------------

describe('createGoogleGateway', () => {
  it('uses default provider when no custom config', () => {
    const config: LlmProviderConfig = { provider: 'google', model: 'gemini-pro' }
    const gw = createGoogleGateway(config)

    expect(gw).toBeInstanceOf(SdkLlmGateway)
    expect(gw.getProviderInfo()).toEqual({ provider: 'google', model: 'gemini-pro' })
  })

  it('uses createGoogleGenerativeAI factory when apiKey is provided', () => {
    const config: LlmProviderConfig = {
      provider: 'google',
      model: 'gemini-pro',
      apiKey: 'google-key',
    }
    const gw = createGoogleGateway(config)

    expect(gw).toBeInstanceOf(SdkLlmGateway)
  })
})
