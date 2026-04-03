import { injectProviderEnv } from '@tianji/agent'
import { afterEach, describe, expect, it } from 'vitest'

import type { LoadedUserConfigContext } from '../config.js'

const KNOWN_ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']

function createTestContext(provider: string, apiKey?: string): LoadedUserConfigContext {
  return {
    paths: {
      configDir: '/tmp/test',
      agentsDir: '/tmp/test/agents',
      logsDir: '/tmp/test/logs',
      configFilePath: '/tmp/test/tianji.json',
      cliLogFilePath: '/tmp/test/logs/tianji.log',
      daemonPortPath: '/tmp/test/daemon.port',
      daemonPidPath: '/tmp/test/daemon.pid',
    },
    config: {},
    agent: {
      agentName: 'default',
      modelRef: `${provider}/model`,
      provider,
      modelName: 'model',
      providerConfig: apiKey !== undefined ? { apiKey } : undefined,
      soulPath: '/tmp/test/agents/default/SOUL.md',
      soul: 'test',
    },
    resolvedEnvVars: [],
    snapshotStore: {} as LoadedUserConfigContext['snapshotStore'],
  }
}

afterEach(() => {
  for (const key of KNOWN_ENV_KEYS) {
    delete process.env[key]
  }
})

describe('injectProviderEnv', () => {
  it('injects OPENAI_API_KEY for openai provider', () => {
    const context = createTestContext('openai', 'sk-test-key')

    injectProviderEnv(context)

    expect(process.env.OPENAI_API_KEY).toBe('sk-test-key')
  })

  it('injects ANTHROPIC_API_KEY for anthropic provider', () => {
    const context = createTestContext('anthropic', 'ant-test-key')

    injectProviderEnv(context)

    expect(process.env.ANTHROPIC_API_KEY).toBe('ant-test-key')
  })

  it('injects GOOGLE_GENERATIVE_AI_API_KEY for google provider', () => {
    const context = createTestContext('google', 'google-test-key')

    injectProviderEnv(context)

    expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('google-test-key')
  })

  it('silently skips unknown provider', () => {
    const context = createTestContext('unknown-provider', 'some-key')

    expect(() => injectProviderEnv(context)).not.toThrow()

    for (const key of KNOWN_ENV_KEYS) {
      expect(process.env[key]).toBeUndefined()
    }
  })

  it('silently skips when providerConfig is undefined', () => {
    const context = createTestContext('openai')

    injectProviderEnv(context)

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

  it('silently skips when apiKey is empty string', () => {
    const context = createTestContext('openai', '')

    injectProviderEnv(context)

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })
})
