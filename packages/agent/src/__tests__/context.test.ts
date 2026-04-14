import * as fs from 'node:fs/promises'

import { FileSnapshotStore } from '@tianji/runtime'
import * as runtime from '@tianji/runtime'
import * as shared from '@tianji/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentAppPaths, LoadedAgentContext } from '../context.js'
import {
  ensureDefaultUserConfig,
  getAgentAppPaths,
  injectProviderEnv,
  loadAgentContext,
  loadAgentContextForName,
} from '../context.js'

const KNOWN_ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']

function createTestContext(provider: string, apiKey?: string): LoadedAgentContext {
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
      workspace: undefined,
    },
    resolvedEnvVars: [],
    snapshotStore: new FileSnapshotStore('/tmp/test/runtime-snapshots'),
  }
}

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    access: vi.fn(),
  }
})

vi.mock('@tianji/runtime', async () => {
  const actual = await vi.importActual<typeof import('@tianji/runtime')>('@tianji/runtime')
  return {
    ...actual,
    loadResolvedConfig: vi.fn(),
  }
})

vi.mock('@tianji/shared', async () => {
  const actual = await vi.importActual<typeof import('@tianji/shared')>('@tianji/shared')
  return {
    ...actual,
    getDefaultAgentDefinition: vi.fn(actual.getDefaultAgentDefinition),
    parseAgentModelRef: vi.fn(actual.parseAgentModelRef),
    getAgentSoulPath: vi.fn(actual.getAgentSoulPath),
    loadAgentSoul: vi.fn(),
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of KNOWN_ENV_KEYS) {
    delete process.env[key]
  }
})

describe('agent context', () => {
  it('returns stable default app paths', () => {
    const paths = getAgentAppPaths()

    expect(paths.configDir).toContain('.config/tianji-ai')
    expect(paths.agentsDir).toContain('.config/tianji-ai/agents')
    expect(paths.logsDir).toContain('.config/tianji-ai/logs')
    expect(paths.configFilePath).toContain('.config/tianji-ai/tianji.json')
    expect(paths.cliLogFilePath).toContain('.config/tianji-ai/logs/tianji.log')
    expect(paths.daemonPortPath).toContain('.config/tianji-ai/daemon.port')
    expect(paths.daemonPidPath).toContain('.config/tianji-ai/daemon.pid')
  })

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
})

function createTestPaths(): AgentAppPaths {
  return {
    configDir: '/tmp/tianji-ctx-test',
    agentsDir: '/tmp/tianji-ctx-test/agents',
    logsDir: '/tmp/tianji-ctx-test/logs',
    configFilePath: '/tmp/tianji-ctx-test/tianji.json',
    cliLogFilePath: '/tmp/tianji-ctx-test/logs/tianji.log',
    daemonPortPath: '/tmp/tianji-ctx-test/daemon.port',
    daemonPidPath: '/tmp/tianji-ctx-test/daemon.pid',
  }
}

describe('ensureDefaultUserConfig', () => {
  it('creates directories and writes config when files do not exist', async () => {
    const paths = createTestPaths()
    const mockedAccess = vi.mocked(fs.access)
    // access rejects → file does not exist
    mockedAccess.mockRejectedValue(new Error('ENOENT'))

    vi.mocked(runtime.loadResolvedConfig).mockResolvedValue({
      config: {},
      resolvedEnvVars: [],
      paths: {} as never,
      workspace: {} as never,
      layers: [],
    })

    vi.mocked(shared.getAgentSoulPath).mockReturnValue(
      '/tmp/tianji-ctx-test/agents/default/SOUL.md'
    )

    const result = await ensureDefaultUserConfig(paths)

    expect(result).toBe(paths)
    expect(fs.mkdir).toHaveBeenCalledWith(paths.configDir, { recursive: true })
    expect(fs.mkdir).toHaveBeenCalledWith(paths.agentsDir, { recursive: true })
    expect(fs.mkdir).toHaveBeenCalledWith(paths.logsDir, { recursive: true })
    // Config file did not exist, so writeFile is called for it
    expect(fs.writeFile).toHaveBeenCalledWith(paths.configFilePath, '{}\n', 'utf8')
    // Soul file did not exist, so writeFile is called for it
    expect(fs.writeFile).toHaveBeenCalledWith(
      '/tmp/tianji-ctx-test/agents/default/SOUL.md',
      expect.stringContaining('Default Tianji Agent'),
      'utf8'
    )
  })

  it('skips writing files when they already exist', async () => {
    const paths = createTestPaths()
    const mockedAccess = vi.mocked(fs.access)
    // access resolves → file exists
    mockedAccess.mockResolvedValue(undefined)

    vi.mocked(runtime.loadResolvedConfig).mockResolvedValue({
      config: {},
      resolvedEnvVars: [],
      paths: {} as never,
      workspace: {} as never,
      layers: [],
    })

    vi.mocked(shared.getAgentSoulPath).mockReturnValue(
      '/tmp/tianji-ctx-test/agents/default/SOUL.md'
    )

    await ensureDefaultUserConfig(paths)

    // writeFile should NOT be called since both files exist
    expect(fs.writeFile).not.toHaveBeenCalled()
  })

  it('reads defaultAgent name from config', async () => {
    const paths = createTestPaths()
    vi.mocked(fs.access).mockResolvedValue(undefined)

    vi.mocked(runtime.loadResolvedConfig).mockResolvedValue({
      config: { agents: { defaultAgent: 'custom-agent', items: {} } },
      resolvedEnvVars: [],
      paths: {} as never,
      workspace: {} as never,
      layers: [],
    })

    vi.mocked(shared.getAgentSoulPath).mockReturnValue(
      '/tmp/tianji-ctx-test/agents/custom-agent/SOUL.md'
    )

    await ensureDefaultUserConfig(paths)

    expect(shared.getAgentSoulPath).toHaveBeenCalledWith(paths.configDir, 'custom-agent')
  })
})

describe('loadAgentContext', () => {
  it('returns a fully populated LoadedAgentContext', async () => {
    // Mock access to always succeed (files exist)
    vi.mocked(fs.access).mockResolvedValue(undefined)

    vi.mocked(runtime.loadResolvedConfig).mockResolvedValue({
      config: {
        agents: {
          defaultAgent: 'test-agent',
          items: {
            'test-agent': { model: 'openai/gpt-4' },
          },
        },
        providers: {
          openai: { apiKey: 'sk-xxx' },
        },
      },
      resolvedEnvVars: ['OPENAI_API_KEY'],
      paths: {} as never,
      workspace: {} as never,
      layers: [],
    })

    vi.mocked(shared.getDefaultAgentDefinition).mockReturnValue({
      agentName: 'test-agent',
      agent: { model: 'openai/gpt-4' },
    })

    vi.mocked(shared.parseAgentModelRef).mockReturnValue({
      provider: 'openai',
      modelName: 'gpt-4',
    })

    vi.mocked(shared.getAgentSoulPath).mockReturnValue('/tmp/agents/test-agent/SOUL.md')
    vi.mocked(shared.loadAgentSoul).mockResolvedValue('You are a test agent.')

    const ctx = await loadAgentContext()

    expect(ctx.agent.agentName).toBe('test-agent')
    expect(ctx.agent.provider).toBe('openai')
    expect(ctx.agent.modelName).toBe('gpt-4')
    expect(ctx.agent.modelRef).toBe('openai/gpt-4')
    expect(ctx.agent.providerConfig).toEqual({ apiKey: 'sk-xxx' })
    expect(ctx.agent.soul).toBe('You are a test agent.')
    expect(ctx.resolvedEnvVars).toEqual(['OPENAI_API_KEY'])
    expect(ctx.snapshotStore).toBeInstanceOf(FileSnapshotStore)
  })

  it('loads an isolated context for a named agent', async () => {
    const providerConfig = { apiKey: 'sk-reviewer' }
    const baseContext: LoadedAgentContext = {
      ...createTestContext('openai', 'sk-base'),
      config: {
        agents: {
          defaultAgent: 'default',
          items: {
            default: { model: 'openai/gpt-4o-mini' },
            reviewer: { model: 'anthropic/claude-3-7-sonnet' },
          },
        },
        providers: {
          anthropic: providerConfig,
        },
      },
    }

    vi.mocked(shared.parseAgentModelRef).mockReturnValue({
      provider: 'anthropic',
      modelName: 'claude-3-7-sonnet',
    })
    vi.mocked(shared.getAgentSoulPath).mockReturnValue('/tmp/test/agents/reviewer/SOUL.md')
    vi.mocked(shared.loadAgentSoul).mockResolvedValue('reviewer soul')

    const result = await loadAgentContextForName('reviewer', baseContext)

    expect(result).not.toBe(baseContext)
    expect(result.config).not.toBe(baseContext.config)
    expect(result.paths).toBe(baseContext.paths)
    expect(result.snapshotStore).toBe(baseContext.snapshotStore)
    expect(result.agent.agentName).toBe('reviewer')
    expect(result.agent.modelRef).toBe('anthropic/claude-3-7-sonnet')
    expect(result.agent.providerConfig).toBe(providerConfig)
    expect(result.agent.soul).toBe('reviewer soul')
    expect(baseContext.config.agents?.defaultAgent).toBe('default')
  })

  it('throws when named agent has no model', async () => {
    const baseContext: LoadedAgentContext = {
      ...createTestContext('openai', 'sk-base'),
      config: {
        agents: {
          defaultAgent: 'default',
          items: {
            default: { model: 'openai/gpt-4o-mini' },
            reviewer: {},
          },
        },
      },
    }

    await expect(loadAgentContextForName('reviewer', baseContext)).rejects.toThrow(
      'Agent "reviewer" must have a "model" field for native agent execution'
    )
  })
})
