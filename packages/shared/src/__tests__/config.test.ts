import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OBSERVER_CONFIG,
  DEFAULT_PATH_POLICY_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_RUNTIME_CONFIG,
  DEFAULT_TIANJI_CONFIG,
  DEFAULT_TOOL_CONFIG,
  type EnvResolver,
  type TianjiConfig,
  TianjiConfigSchema,
  extractEnvVarName,
  isEnvPlaceholder,
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

    it('should resolve placeholders in simple object', () => {
      const config = {
        llm: {
          providers: {
            openai: {
              apiKey: '${env:OPENAI_API_KEY}',
            },
          },
        },
      }

      const result = resolveConfigPlaceholders(config, mockResolver)
      expect(result.config.llm.providers.openai.apiKey).toBe('sk-test-key')
      expect(result.resolvedVars).toContain('OPENAI_API_KEY')
    })

    it('should resolve multiple placeholders', () => {
      const config = {
        llm: {
          providers: {
            openai: {
              apiKey: '${env:OPENAI_API_KEY}',
            },
            anthropic: {
              apiKey: '${env:ANTHROPIC_API_KEY}',
            },
          },
        },
      }

      const result = resolveConfigPlaceholders(config, mockResolver)
      expect(result.config.llm.providers.openai.apiKey).toBe('sk-test-key')
      expect(result.config.llm.providers.anthropic.apiKey).toBe('ant-test-key')
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
        llm: {
          providers: {
            openai: {
              apiKey: '${env:UNDEFINED_VAR}',
            },
          },
        },
      }

      expect(() => resolveConfigPlaceholders(config, mockResolver)).toThrow(
        'Environment variable "UNDEFINED_VAR" is not defined'
      )
    })

    it('should resolve empty string env value', () => {
      const config = {
        llm: {
          providers: {
            test: {
              apiKey: '${env:EMPTY_VAR}',
            },
          },
        },
      }

      const result = resolveConfigPlaceholders(config, mockResolver)
      expect(result.config.llm.providers.test.apiKey).toBe('')
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
        llm: {
          defaultProvider: 'openai',
          defaultModel: 'gpt-4.1',
          providers: {
            openai: {
              apiKey: 'sk-test',
            },
            anthropic: {
              apiKey: 'ant-test',
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
        llm: {
          providers: {
            openai: {
              apiKey: '${env:OPENAI_API_KEY}',
            },
          },
        },
      }

      const result = TianjiConfigSchema.parse(config)
      expect(result.llm?.providers?.openai?.apiKey).toBe('${env:OPENAI_API_KEY}')
    })

    it('should reject invalid types', () => {
      expect(() =>
        TianjiConfigSchema.parse({
          llm: {
            defaultProvider: 123, // Should be string
          },
        })
      ).toThrow()

      expect(() =>
        TianjiConfigSchema.parse({
          runtime: {
            retry: {
              maxAttempts: 'three', // Should be number
            },
          },
        })
      ).toThrow()
    })
  })

  describe('validateTianjiConfig', () => {
    it('should return typed config on valid input', () => {
      const config = {
        llm: {
          defaultProvider: 'openai',
        },
      }

      const result = validateTianjiConfig(config)
      expect(result.llm?.defaultProvider).toBe('openai')
    })

    it('should throw on invalid input', () => {
      expect(() =>
        validateTianjiConfig({
          llm: {
            defaultProvider: 123,
          },
        })
      ).toThrow()
    })
  })

  describe('safeValidateTianjiConfig', () => {
    it('should return success true on valid input', () => {
      const config = {
        llm: {
          defaultProvider: 'openai',
        },
      }

      const result = safeValidateTianjiConfig(config)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.llm?.defaultProvider).toBe('openai')
      }
    })

    it('should return success false on invalid input', () => {
      const result = safeValidateTianjiConfig({
        llm: {
          defaultProvider: 123,
        },
      })
      expect(result.success).toBe(false)
    })
  })

  describe('DEFAULT_RETRY_CONFIG', () => {
    it('should have required fields', () => {
      expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(2)
      expect(DEFAULT_RETRY_CONFIG.baseDelayMs).toBe(300)
      expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(3000)
    })

    it('should match CONFIG_DESIGN.md defaults', () => {
      // From docs/CONFIG_DESIGN.md lines 224-227
      expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(2)
      expect(DEFAULT_RETRY_CONFIG.baseDelayMs).toBe(300)
      expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(3000)
    })
  })

  describe('DEFAULT_PATH_POLICY_CONFIG', () => {
    it('should have required fields', () => {
      expect(Array.isArray(DEFAULT_PATH_POLICY_CONFIG.forbidDirectories)).toBe(true)
      expect(Array.isArray(DEFAULT_PATH_POLICY_CONFIG.filenameDenyPatterns)).toBe(true)
    })

    it('should include common forbidden directories', () => {
      expect(DEFAULT_PATH_POLICY_CONFIG.forbidDirectories).toContain('.git/')
      expect(DEFAULT_PATH_POLICY_CONFIG.forbidDirectories).toContain('node_modules/')
    })

    it('should include common deny patterns', () => {
      expect(DEFAULT_PATH_POLICY_CONFIG.filenameDenyPatterns).toContain('^\\.env($|\\.)')
      expect(DEFAULT_PATH_POLICY_CONFIG.filenameDenyPatterns).toContain('(^|/)id_rsa$')
    })
  })

  describe('DEFAULT_TOOL_CONFIG', () => {
    it('should have required fields', () => {
      expect(DEFAULT_TOOL_CONFIG.timeoutMs).toBe(120000)
      expect(DEFAULT_TOOL_CONFIG.maxConcurrency).toBe(4)
      expect(DEFAULT_TOOL_CONFIG.allowDestructive).toBe(false)
    })

    it('should match CONFIG_DESIGN.md defaults', () => {
      // From docs/CONFIG_DESIGN.md lines 229-233
      expect(DEFAULT_TOOL_CONFIG.timeoutMs).toBe(120000)
      expect(DEFAULT_TOOL_CONFIG.maxConcurrency).toBe(4)
      expect(DEFAULT_TOOL_CONFIG.allowDestructive).toBe(false)
    })

    it('should have safe default for allowDestructive', () => {
      expect(DEFAULT_TOOL_CONFIG.allowDestructive).toBe(false)
    })
  })

  describe('DEFAULT_OBSERVER_CONFIG', () => {
    it('should have required fields', () => {
      expect(DEFAULT_OBSERVER_CONFIG.enabled).toBe(true)
      expect(DEFAULT_OBSERVER_CONFIG.redactSecrets).toBe(true)
    })

    it('should match CONFIG_DESIGN.md defaults', () => {
      // From docs/CONFIG_DESIGN.md lines 245-248
      expect(DEFAULT_OBSERVER_CONFIG.enabled).toBe(true)
      expect(DEFAULT_OBSERVER_CONFIG.redactSecrets).toBe(true)
    })
  })

  describe('DEFAULT_TIANJI_CONFIG', () => {
    it('should have all top-level sections', () => {
      expect(DEFAULT_TIANJI_CONFIG.llm).toBeDefined()
      expect(DEFAULT_TIANJI_CONFIG.runtime).toBeDefined()
      expect(DEFAULT_TIANJI_CONFIG.observer).toBeDefined()
    })

    it('should be valid against schema', () => {
      const result = TianjiConfigSchema.safeParse(DEFAULT_TIANJI_CONFIG)
      expect(result.success).toBe(true)
    })
  })
})
