import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENTS_CONFIG,
  DEFAULT_AGENT_CONFIG,
  DEFAULT_OBSERVER_CONFIG,
  DEFAULT_PATH_POLICY_CONFIG,
  DEFAULT_PROVIDERS_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_RUNTIME_CONFIG,
  DEFAULT_TIANJI_CONFIG,
  DEFAULT_TOOL_CONFIG,
  type EnvResolver,
  SUPPORTED_LOCALES,
  type TianjiConfig,
  TianjiConfigSchema,
  createDefaultUserTianjiConfig,
  extractEnvVarName,
  getAgentSoulPath,
  getDefaultAgentDefinition,
  isEnvPlaceholder,
  loadAgentSoul,
  mergeTianjiConfigLayers,
  parseAgentModelRef,
  resolveConfigPlaceholders,
  resolveEnvPlaceholder,
  safeValidateTianjiConfig,
  validateTianjiConfig,
} from '../config.js'

describe('config', () => {
  describe('isEnvPlaceholder', () => {
    it('should return true for valid placeholder syntax', () => {
      expect(isEnvPlaceholder('${env:OPENAI_API_KEY}')).toBe(true)
      expect(isEnvPlaceholder('${env:MY_VAR}')).toBe(true)
      expect(isEnvPlaceholder('${env:A}')).toBe(true)
      expect(isEnvPlaceholder('${env:_UNDERSCORE}')).toBe(true)
      expect(isEnvPlaceholder('${env:VAR_123}')).toBe(true)
    })

    it('should return false for invalid placeholder syntax', () => {
      expect(isEnvPlaceholder('not a placeholder')).toBe(false)
      expect(isEnvPlaceholder('${env:}')).toBe(false)
      expect(isEnvPlaceholder('${env:123INVALID}')).toBe(false)
      expect(isEnvPlaceholder('$env:VAR')).toBe(false)
      expect(isEnvPlaceholder('${ENV:VAR}')).toBe(false)
      expect(isEnvPlaceholder('${env:VAR')).toBe(false)
      expect(isEnvPlaceholder('$env:VAR}')).toBe(false)
      expect(isEnvPlaceholder('prefix${env:VAR}suffix')).toBe(false)
    })
  })

  describe('extractEnvVarName', () => {
    it('should extract variable name from valid placeholder', () => {
      expect(extractEnvVarName('${env:OPENAI_API_KEY}')).toBe('OPENAI_API_KEY')
      expect(extractEnvVarName('${env:MY_VAR}')).toBe('MY_VAR')
      expect(extractEnvVarName('${env:A}')).toBe('A')
    })

    it('should return null for invalid placeholder', () => {
      expect(extractEnvVarName('not a placeholder')).toBe(null)
      expect(extractEnvVarName('${env:}')).toBe(null)
      expect(extractEnvVarName('${ENV:VAR}')).toBe(null)
    })
  })

  describe('resolveEnvPlaceholder', () => {
    const mockResolver: EnvResolver = (varName: string) => {
      const env: Record<string, string> = {
        OPENAI_API_KEY: 'sk-test-key',
        ANTHROPIC_API_KEY: 'ant-test-key',
        EMPTY_VAR: '',
      }
      return env[varName]
    }

    it('should resolve valid placeholder', () => {
      expect(resolveEnvPlaceholder('${env:OPENAI_API_KEY}', mockResolver)).toBe('sk-test-key')
      expect(resolveEnvPlaceholder('${env:ANTHROPIC_API_KEY}', mockResolver)).toBe('ant-test-key')
    })

    it('should return original value if not a placeholder', () => {
      expect(resolveEnvPlaceholder('plain string', mockResolver)).toBe('plain string')
      expect(resolveEnvPlaceholder('sk-regular-key', mockResolver)).toBe('sk-regular-key')
    })

    it('should resolve empty string env value as valid', () => {
      expect(resolveEnvPlaceholder('${env:EMPTY_VAR}', mockResolver)).toBe('')
    })

    it('should throw for undefined env var', () => {
      expect(() => resolveEnvPlaceholder('${env:UNDEFINED_VAR}', mockResolver)).toThrow(
        'Environment variable "UNDEFINED_VAR" is not defined'
      )
    })
  })

  describe('resolveConfigPlaceholders', () => {
    const mockResolver: EnvResolver = (varName: string) => {
      const env: Record<string, string> = {
        OPENAI_API_KEY: 'sk-test-key',
        ANTHROPIC_API_KEY: 'ant-test-key',
        EMPTY_VAR: '',
      }
      return env[varName]
    }

    it('should resolve placeholders in provider config', () => {
      const config = {
        providers: {
          openai: {
            apiKey: '${env:OPENAI_API_KEY}',
          },
        },
      }

      const result = resolveConfigPlaceholders(config, mockResolver)
      expect(result.config.providers.openai.apiKey).toBe('sk-test-key')
      expect(result.resolvedVars).toContain('OPENAI_API_KEY')
    })

    it('should resolve multiple placeholders', () => {
      const config = {
        providers: {
          openai: {
            apiKey: '${env:OPENAI_API_KEY}',
          },
          anthropic: {
            apiKey: '${env:ANTHROPIC_API_KEY}',
          },
        },
      }

      const result = resolveConfigPlaceholders(config, mockResolver)
      expect(result.config.providers.openai.apiKey).toBe('sk-test-key')
      expect(result.config.providers.anthropic.apiKey).toBe('ant-test-key')
      expect(result.resolvedVars).toHaveLength(2)
    })

    it('should preserve non-string values', () => {
      const config = {
        runtime: {
          retry: {
            maxAttempts: 3,
            baseDelayMs: 1000,
          },
          tool: {
            allowDestructive: false,
          },
        },
      }

      const result = resolveConfigPlaceholders(config, mockResolver)
      expect(result.config.runtime.retry.maxAttempts).toBe(3)
      expect(result.config.runtime.retry.baseDelayMs).toBe(1000)
      expect(result.config.runtime.tool.allowDestructive).toBe(false)
      expect(result.resolvedVars).toHaveLength(0)
    })

    it('should resolve placeholders in arrays', () => {
      const config = {
        keys: ['${env:OPENAI_API_KEY}', '${env:ANTHROPIC_API_KEY}'],
      }

      const result = resolveConfigPlaceholders(config, mockResolver)
      expect(result.config.keys).toEqual(['sk-test-key', 'ant-test-key'])
    })

    it('should preserve null values', () => {
      const config = {
        value: null,
      }

      const result = resolveConfigPlaceholders(config, mockResolver)
      expect(result.config.value).toBe(null)
    })

    it('should throw for unresolved placeholder', () => {
      const config = {
        providers: {
          openai: {
            apiKey: '${env:UNDEFINED_VAR}',
          },
        },
      }

      expect(() => resolveConfigPlaceholders(config, mockResolver)).toThrow(
        'Environment variable "UNDEFINED_VAR" is not defined'
      )
    })

    it('should resolve empty string env value', () => {
      const config = {
        providers: {
          test: {
            apiKey: '${env:EMPTY_VAR}',
          },
        },
      }

      const result = resolveConfigPlaceholders(config, mockResolver)
      expect(result.config.providers.test.apiKey).toBe('')
    })
  })

  describe('TianjiConfigSchema', () => {
    it('should validate minimal empty config', () => {
      const result = TianjiConfigSchema.parse({})
      expect(result).toEqual({})
    })

    it('should reject undefined config', () => {
      expect(() => TianjiConfigSchema.parse(undefined)).toThrow()
    })

    it('should validate complete config', () => {
      const config = {
        providers: {
          openai: {
            apiKey: 'sk-test',
          },
          anthropic: {
            apiKey: 'ant-test',
          },
        },
        agents: {
          defaultAgent: 'default',
          items: {
            default: {
              model: 'openai/gpt-4.1',
            },
            reviewer: {
              model: 'anthropic/claude-3-7-sonnet',
            },
          },
        },
        runtime: {
          retry: {
            maxAttempts: 2,
            baseDelayMs: 300,
            maxDelayMs: 3000,
          },
          tool: {
            timeoutMs: 120000,
            maxConcurrency: 4,
            allowDestructive: false,
            pathPolicy: {
              forbidDirectories: ['.git/', 'node_modules/'],
              filenameDenyPatterns: ['^\\.env($|\\.)', '(^|/)id_rsa$'],
            },
          },
        },
        observer: {
          enabled: true,
          redactSecrets: true,
        },
      }

      const result = TianjiConfigSchema.parse(config)
      expect(result).toEqual(config)
    })

    it('should validate config with placeholders', () => {
      const config = {
        providers: {
          openai: {
            apiKey: '${env:OPENAI_API_KEY}',
          },
        },
        agents: {
          defaultAgent: 'default',
          items: {
            default: {
              model: 'openai/gpt-4.1',
            },
          },
        },
      }

      const result = TianjiConfigSchema.parse(config)
      expect(result.providers?.openai?.apiKey).toBe('${env:OPENAI_API_KEY}')
    })

    it('accepts locale at top level of Tianji config', () => {
      const result = TianjiConfigSchema.safeParse({
        locale: 'zh-CN',
        providers: {},
      })

      expect(result.success).toBe(true)
    })

    it('rejects unsupported locale values', () => {
      const result = TianjiConfigSchema.safeParse({
        locale: 'fr-FR',
      })

      expect(result.success).toBe(false)
    })

    it('exports supported locales in shared public API', () => {
      expect(SUPPORTED_LOCALES).toEqual(['en', 'zh-CN'])
    })

    it('should reject invalid types and names', () => {
      expect(() =>
        TianjiConfigSchema.parse({
          providers: {
            openai: {
              apiKey: 123,
            },
          },
        })
      ).toThrow()

      expect(() =>
        TianjiConfigSchema.parse({
          agents: {
            defaultAgent: 'Default',
          },
        })
      ).toThrow()

      expect(() =>
        TianjiConfigSchema.parse({
          runtime: {
            retry: {
              maxAttempts: 'three',
            },
          },
        })
      ).toThrow()
    })
  })

  describe('validateTianjiConfig', () => {
    it('should return typed config on valid input', () => {
      const config = {
        providers: {
          openai: {
            apiKey: 'sk-test',
          },
        },
        agents: {
          defaultAgent: 'default',
          items: {
            default: {
              model: 'openai/gpt-4.1',
            },
          },
        },
      }

      const result = validateTianjiConfig(config)
      expect(result.agents?.defaultAgent).toBe('default')
    })

    it('should throw on invalid input', () => {
      expect(() =>
        validateTianjiConfig({
          agents: {
            defaultAgent: 'default',
            items: {
              default: {
                model: 'openai/',
              },
            },
          },
        })
      ).toThrow()
    })
  })

  describe('safeValidateTianjiConfig', () => {
    it('should return success true on valid input', () => {
      const config = {
        agents: {
          defaultAgent: 'default',
          items: {
            default: {
              model: 'openai/gpt-4.1',
            },
          },
        },
      }

      const result = safeValidateTianjiConfig(config)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.agents?.defaultAgent).toBe('default')
      }
    })

    it('should return success false on invalid input', () => {
      const result = safeValidateTianjiConfig({
        agents: {
          defaultAgent: 'default',
          items: {
            default: {
              model: 'openai/',
            },
          },
        },
      })
      expect(result.success).toBe(false)
    })
  })

  describe('mergeTianjiConfigLayers', () => {
    it('should deep merge object fields across layers', () => {
      const merged = mergeTianjiConfigLayers(
        {
          providers: {
            openai: {
              apiKey: '${env:OPENAI_API_KEY}',
              baseUrl: 'https://api.openai.com/v1',
            },
          },
          runtime: {
            tool: {
              timeoutMs: 120000,
            },
          },
        },
        {
          providers: {
            openai: {
              baseUrl: 'https://example.test/v1',
            },
            anthropic: {
              apiKey: '${env:ANTHROPIC_API_KEY}',
            },
          },
          runtime: {
            tool: {
              maxConcurrency: 8,
            },
          },
        }
      )

      expect(merged).toEqual({
        providers: {
          openai: {
            apiKey: '${env:OPENAI_API_KEY}',
            baseUrl: 'https://example.test/v1',
          },
          anthropic: {
            apiKey: '${env:ANTHROPIC_API_KEY}',
          },
        },
        runtime: {
          tool: {
            timeoutMs: 120000,
            maxConcurrency: 8,
          },
        },
      })
    })

    it('should replace arrays instead of concatenating them', () => {
      const merged = mergeTianjiConfigLayers(
        {
          runtime: {
            tool: {
              pathPolicy: {
                forbidDirectories: ['.git/', 'node_modules/'],
              },
            },
          },
        },
        {
          runtime: {
            tool: {
              pathPolicy: {
                forbidDirectories: ['dist/'],
              },
            },
          },
        }
      )

      expect(merged.runtime?.tool?.pathPolicy?.forbidDirectories).toEqual(['dist/'])
    })

    it('should replace scalar values from higher-priority layers', () => {
      const merged = mergeTianjiConfigLayers(
        {
          observer: {
            enabled: true,
          },
        },
        {
          observer: {
            enabled: false,
          },
        }
      )

      expect(merged.observer?.enabled).toBe(false)
    })

    it('should not mutate input layer objects', () => {
      const base: TianjiConfig = {
        runtime: {
          tool: {
            pathPolicy: {
              forbidDirectories: ['.git/'],
            },
          },
        },
      }
      const override: TianjiConfig = {
        runtime: {
          tool: {
            pathPolicy: {
              forbidDirectories: ['dist/'],
            },
          },
        },
      }

      const merged = mergeTianjiConfigLayers(base, override)
      merged.runtime?.tool?.pathPolicy?.forbidDirectories?.push('coverage/')

      expect(base.runtime?.tool?.pathPolicy?.forbidDirectories).toEqual(['.git/'])
      expect(override.runtime?.tool?.pathPolicy?.forbidDirectories).toEqual(['dist/'])
    })
  })

  describe('parseAgentModelRef', () => {
    it('should parse provider and model name', () => {
      expect(parseAgentModelRef('openai/gpt-4.1')).toEqual({
        provider: 'openai',
        modelName: 'gpt-4.1',
      })
    })

    it('should split on the first slash only', () => {
      expect(parseAgentModelRef('openai/responses/gpt-4.1')).toEqual({
        provider: 'openai',
        modelName: 'responses/gpt-4.1',
      })
    })

    it('should reject missing provider', () => {
      expect(() => parseAgentModelRef('/gpt-4.1')).toThrow('must include a provider before "/"')
    })

    it('should reject missing model name', () => {
      expect(() => parseAgentModelRef('openai/')).toThrow('must include a model name after "/"')
    })

    it('should reject missing slash', () => {
      expect(() => parseAgentModelRef('openai')).toThrow('must include "/"')
    })
  })

  describe('getDefaultAgentDefinition', () => {
    it('should return the configured default agent', () => {
      const config: TianjiConfig = {
        agents: {
          defaultAgent: 'reviewer',
          items: {
            default: {
              model: 'openai/gpt-4.1',
            },
            reviewer: {
              model: 'anthropic/claude-3-7-sonnet',
            },
          },
        },
      }

      expect(getDefaultAgentDefinition(config)).toEqual({
        agentName: 'reviewer',
        agent: {
          model: 'anthropic/claude-3-7-sonnet',
        },
      })
    })

    it('should throw when agents.defaultAgent is missing', () => {
      const config: TianjiConfig = {
        agents: {
          items: {
            default: {
              model: 'openai/gpt-4.1',
            },
          },
        },
      }

      expect(() => getDefaultAgentDefinition(config)).toThrow(
        'Missing agents.defaultAgent in Tianji config'
      )
    })

    it('should throw when agents.items is missing', () => {
      const config: TianjiConfig = {
        agents: {
          defaultAgent: 'default',
        },
      }

      expect(() => getDefaultAgentDefinition(config)).toThrow(
        'Missing agents.items in Tianji config'
      )
    })

    it('should throw when the default item is missing', () => {
      const config: TianjiConfig = {
        agents: {
          defaultAgent: 'default',
          items: {
            reviewer: {
              model: 'openai/gpt-4.1',
            },
          },
        },
      }

      expect(() => getDefaultAgentDefinition(config)).toThrow(
        'Default agent "default" is not defined in agents.items'
      )
    })
  })

  describe('getAgentSoulPath', () => {
    it('should build the conventional soul path', () => {
      expect(getAgentSoulPath('/tmp/tianji', 'default')).toBe(
        join('/tmp/tianji', 'agents', 'default', 'SOUL.md')
      )
    })
  })

  describe('loadAgentSoul', () => {
    it('should read non-empty soul content', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'tianji-shared-'))

      try {
        const agentDir = join(tempDir, 'agents', 'default')
        await mkdir(agentDir, { recursive: true })
        const filePath = join(agentDir, 'SOUL.md')
        await writeFile(filePath, '# Default Agent\n\nKeep answers concise.\n', 'utf8')

        await expect(loadAgentSoul(filePath)).resolves.toBe(
          '# Default Agent\n\nKeep answers concise.\n'
        )
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('should reject empty or whitespace-only files', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'tianji-shared-'))

      try {
        const filePath = join(tempDir, 'SOUL.md')
        await writeFile(filePath, '   \n\t', 'utf8')

        await expect(loadAgentSoul(filePath)).rejects.toThrow('Agent soul file is empty')
      } finally {
        await rm(tempDir, { recursive: true, force: true })
      }
    })

    it('should reject missing files', async () => {
      const missingPath = join(tmpdir(), 'tianji-shared-missing', 'SOUL.md')
      await expect(loadAgentSoul(missingPath)).rejects.toThrow('Agent soul file does not exist')
    })
  })

  describe('DEFAULT_RETRY_CONFIG', () => {
    it('should have required fields', () => {
      expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(2)
      expect(DEFAULT_RETRY_CONFIG.baseDelayMs).toBe(300)
      expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(3000)
    })
  })

  describe('DEFAULT_PATH_POLICY_CONFIG', () => {
    it('should include safe path defaults', () => {
      expect(DEFAULT_PATH_POLICY_CONFIG.forbidDirectories).toContain('.git/')
      expect(DEFAULT_PATH_POLICY_CONFIG.forbidDirectories).toContain('node_modules/')
      expect(DEFAULT_PATH_POLICY_CONFIG.filenameDenyPatterns).toContain('^\\.env($|\\.)')
      expect(DEFAULT_PATH_POLICY_CONFIG.filenameDenyPatterns).toContain('(^|/)id_rsa$')
    })
  })

  describe('DEFAULT_TOOL_CONFIG', () => {
    it('should keep safe tool defaults', () => {
      expect(DEFAULT_TOOL_CONFIG.timeoutMs).toBe(120000)
      expect(DEFAULT_TOOL_CONFIG.maxConcurrency).toBe(4)
      expect(DEFAULT_TOOL_CONFIG.allowDestructive).toBe(false)
    })
  })

  describe('DEFAULT_RUNTIME_CONFIG', () => {
    it('should keep retry and tool defaults', () => {
      expect(DEFAULT_RUNTIME_CONFIG.retry).toEqual(DEFAULT_RETRY_CONFIG)
      expect(DEFAULT_RUNTIME_CONFIG.tool).toEqual(DEFAULT_TOOL_CONFIG)
    })
  })

  describe('DEFAULT_OBSERVER_CONFIG', () => {
    it('should keep observer defaults', () => {
      expect(DEFAULT_OBSERVER_CONFIG.enabled).toBe(true)
      expect(DEFAULT_OBSERVER_CONFIG.redactSecrets).toBe(true)
    })
  })

  describe('default agent config helpers', () => {
    it('should expose provider and agent defaults', () => {
      expect(DEFAULT_PROVIDERS_CONFIG.openai.apiKey).toBe('${env:OPENAI_API_KEY}')
      expect(DEFAULT_AGENT_CONFIG.model).toBe('openai/gpt-4.1')
      expect(DEFAULT_AGENTS_CONFIG.defaultAgent).toBe('default')
      expect(DEFAULT_AGENTS_CONFIG.items?.default).toEqual(DEFAULT_AGENT_CONFIG)
    })

    it('should create an isolated default user config', () => {
      const created = createDefaultUserTianjiConfig()
      created.providers = {
        test: {
          apiKey: 'overridden',
        },
      }

      expect(DEFAULT_TIANJI_CONFIG.providers).toEqual(DEFAULT_PROVIDERS_CONFIG)
      expect(created.providers).not.toEqual(DEFAULT_TIANJI_CONFIG.providers)
    })
  })

  describe('DEFAULT_TIANJI_CONFIG', () => {
    it('should have all top-level sections', () => {
      expect(DEFAULT_TIANJI_CONFIG.providers).toBeDefined()
      expect(DEFAULT_TIANJI_CONFIG.agents).toBeDefined()
      expect(DEFAULT_TIANJI_CONFIG.runtime).toBeDefined()
      expect(DEFAULT_TIANJI_CONFIG.observer).toBeDefined()
    })

    it('should be valid against schema', () => {
      const result = TianjiConfigSchema.safeParse(DEFAULT_TIANJI_CONFIG)
      expect(result.success).toBe(true)
    })

    it('should produce a valid user config factory result', () => {
      const result = TianjiConfigSchema.safeParse(createDefaultUserTianjiConfig())
      expect(result.success).toBe(true)
    })
  })
})
