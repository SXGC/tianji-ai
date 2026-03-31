import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type RuntimeConfigError,
  createWorkspaceId,
  loadResolvedConfig,
  resolveConfigPaths,
  resolveWorkspaceConfig,
} from '../config.js'

const createdDirs: string[] = []
const defaultConfigPath = fileURLToPath(new URL('../../../../tianji.config.json', import.meta.url))

describe('runtime config loader', () => {
  afterEach(async () => {
    Reflect.deleteProperty(process.env, 'OPENAI_API_KEY')
    Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY')

    await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('should resolve stable config paths for a workspace', async () => {
    const sandbox = await createSandbox()
    const workspaceRoot = join(sandbox, 'workspace')
    const homeDir = join(sandbox, 'home')
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(homeDir, { recursive: true })

    const workspace = resolveWorkspaceConfig({ workspaceRoot, userHomeDir: homeDir })
    const paths = resolveConfigPaths({ workspaceRoot, userHomeDir: homeDir })

    expect(workspace.root).toBe(workspaceRoot)
    expect(workspace.id).toBe(createWorkspaceId(workspace.normalizedRoot))
    expect(paths.defaultConfigPath).toBe(defaultConfigPath)
    expect(paths.userConfigPath).toBe(join(homeDir, '.config', 'tianji-ai', 'tianji.json'))
    expect(paths.workspaceConfigPath).toBe(
      join(homeDir, '.config', 'tianji-ai', 'workspaces', `${workspace.id}.json`)
    )
  })

  it('should merge default, user, and workspace config layers', async () => {
    const sandbox = await createSandbox()
    const workspaceRoot = join(sandbox, 'workspace')
    const homeDir = join(sandbox, 'home')
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(homeDir, { recursive: true })

    process.env.OPENAI_API_KEY = 'sk-default'
    process.env.ANTHROPIC_API_KEY = 'sk-workspace'

    await writeJson(join(homeDir, '.config', 'tianji-ai', 'tianji.json'), {
      runtime: {
        tool: {
          maxConcurrency: 8,
          pathPolicy: {
            forbidDirectories: ['dist/'],
          },
        },
      },
      observer: {
        enabled: false,
      },
    })

    const workspaceId = createWorkspaceId(workspaceRoot)
    await writeJson(join(homeDir, '.config', 'tianji-ai', 'workspaces', `${workspaceId}.json`), {
      providers: {
        anthropic: {
          apiKey: '${env:ANTHROPIC_API_KEY}',
        },
      },
      agents: {
        defaultAgent: 'reviewer',
        items: {
          reviewer: {
            model: 'anthropic/claude-3-7-sonnet',
          },
        },
      },
      observer: {
        redactSecrets: false,
      },
    })

    const result = await loadResolvedConfig({ workspaceRoot, userHomeDir: homeDir })

    expect(result.config.providers?.openai?.apiKey).toBe('sk-default')
    expect(result.config.providers?.openai?.baseUrl).toBe('http://100.78.129.21:8317/v1')
    expect(result.config.providers?.anthropic?.apiKey).toBe('sk-workspace')
    expect(result.config.agents?.defaultAgent).toBe('reviewer')
    expect(result.config.agents?.items?.default?.model).toBe('openai/glm-latest')
    expect(result.config.agents?.items?.reviewer?.model).toBe('anthropic/claude-3-7-sonnet')
    expect(result.config.runtime?.tool?.timeoutMs).toBe(120000)
    expect(result.config.runtime?.tool?.maxConcurrency).toBe(8)
    expect(result.config.runtime?.tool?.pathPolicy?.forbidDirectories).toEqual(['dist/'])
    expect(result.config.observer).toEqual({ enabled: false, redactSecrets: false })
    expect(result.resolvedEnvVars).toEqual(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])
    expect(result.layers.map((layer) => [layer.name, layer.exists])).toEqual([
      ['default', true],
      ['user', true],
      ['workspace', true],
    ])
  })

  it('should fail when default config placeholders cannot be resolved', async () => {
    const sandbox = await createSandbox()
    const workspaceRoot = join(sandbox, 'workspace')
    const homeDir = join(sandbox, 'home')
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(homeDir, { recursive: true })

    await expect(loadResolvedConfig({ workspaceRoot, userHomeDir: homeDir })).rejects.toMatchObject(
      {
        code: 'config.env_missing',
        details: {
          phase: 'placeholder',
          fieldPath: 'OPENAI_API_KEY',
        },
      } satisfies Partial<RuntimeConfigError>
    )
  })

  it('should fail on invalid json in any layer', async () => {
    const sandbox = await createSandbox()
    const workspaceRoot = join(sandbox, 'workspace')
    const homeDir = join(sandbox, 'home')
    await mkdir(workspaceRoot, { recursive: true })
    await mkdir(join(homeDir, '.config', 'tianji-ai'), { recursive: true })

    await writeFile(join(homeDir, '.config', 'tianji-ai', 'tianji.json'), '{ invalid', 'utf8')

    await expect(loadResolvedConfig({ workspaceRoot, userHomeDir: homeDir })).rejects.toMatchObject(
      {
        code: 'config.parse_error',
        details: {
          layer: 'user',
          phase: 'parse',
        },
      } satisfies Partial<RuntimeConfigError>
    )
  })

  it('should fail on schema validation errors in any layer', async () => {
    const sandbox = await createSandbox()
    const workspaceRoot = join(sandbox, 'workspace')
    const homeDir = join(sandbox, 'home')
    await mkdir(workspaceRoot, { recursive: true })

    await writeJson(join(homeDir, '.config', 'tianji-ai', 'tianji.json'), {
      agents: {
        defaultAgent: 'default',
        items: {
          default: {
            model: 'openai/',
          },
        },
      },
    })

    await expect(loadResolvedConfig({ workspaceRoot, userHomeDir: homeDir })).rejects.toMatchObject(
      {
        code: 'config.schema_error',
        details: {
          layer: 'user',
          phase: 'schema',
        },
      } satisfies Partial<RuntimeConfigError>
    )
  })

  it('should fail when a placeholder env var is missing after merge', async () => {
    const sandbox = await createSandbox()
    const workspaceRoot = join(sandbox, 'workspace')
    const homeDir = join(sandbox, 'home')
    await mkdir(workspaceRoot, { recursive: true })

    await writeJson(join(homeDir, '.config', 'tianji-ai', 'tianji.json'), {
      providers: {
        openai: {
          apiKey: '${env:OPENAI_API_KEY}',
        },
      },
    })

    await expect(loadResolvedConfig({ workspaceRoot, userHomeDir: homeDir })).rejects.toMatchObject(
      {
        code: 'config.env_missing',
        details: {
          phase: 'placeholder',
          fieldPath: 'OPENAI_API_KEY',
        },
      } satisfies Partial<RuntimeConfigError>
    )
  })

  it('should treat empty string env values as resolved values', async () => {
    const sandbox = await createSandbox()
    const workspaceRoot = join(sandbox, 'workspace')
    const homeDir = join(sandbox, 'home')
    await mkdir(workspaceRoot, { recursive: true })
    process.env.OPENAI_API_KEY = ''

    await writeJson(join(homeDir, '.config', 'tianji-ai', 'tianji.json'), {
      providers: {
        openai: {
          apiKey: '${env:OPENAI_API_KEY}',
        },
      },
    })

    const result = await loadResolvedConfig({ workspaceRoot, userHomeDir: homeDir })
    expect(result.config.providers?.openai?.apiKey).toBe('')
  })

  it('should create stable workspace ids and distinguish different roots', () => {
    const first = createWorkspaceId('/tmp/workspace-a')
    const second = createWorkspaceId('/tmp/workspace-a')
    const third = createWorkspaceId('/tmp/workspace-b')

    expect(first).toBe(second)
    expect(first).not.toBe(third)
    expect(first).toMatch(/^[a-f0-9]{16}$/)
  })
})

async function createSandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tianji-runtime-config-'))
  createdDirs.push(dir)
  return dir
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const directory = filePath.slice(0, filePath.lastIndexOf('/'))
  await mkdir(directory, { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
