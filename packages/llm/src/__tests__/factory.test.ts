import { describe, expect, it } from 'vitest'

import { createLlmGateway } from '../factory.js'

describe('createLlmGateway', () => {
  it('creates an openai gateway', () => {
    const gateway = createLlmGateway({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
    })

    expect(gateway.getProviderInfo()).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
    })
    expect(gateway.isReady()).toBe(true)
  })

  it('creates an anthropic gateway', () => {
    const gateway = createLlmGateway({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
      apiKey: 'test-key',
    })

    expect(gateway.getProviderInfo()).toEqual({
      provider: 'anthropic',
      model: 'claude-3-5-haiku-latest',
    })
    expect(gateway.isReady()).toBe(true)
  })

  it('creates a google gateway', () => {
    const gateway = createLlmGateway({
      provider: 'google',
      model: 'gemini-2.0-flash',
      apiKey: 'test-key',
    })

    expect(gateway.getProviderInfo()).toEqual({
      provider: 'google',
      model: 'gemini-2.0-flash',
    })
    expect(gateway.isReady()).toBe(true)
  })

  it('treats provider headers as a ready configuration', () => {
    const gateway = createLlmGateway({
      provider: 'openai',
      model: 'gpt-4o-mini',
      headers: {
        authorization: 'Bearer test-token',
      },
    })

    expect(gateway.isReady()).toBe(true)
  })
})
