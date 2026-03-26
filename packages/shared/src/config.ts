/**
 * @tianji/shared - Configuration Schema and Placeholder Resolution
 *
 * This module provides Zod schemas for tianji-ai configuration and
 * environment variable placeholder parsing for `${env:VAR_NAME}` syntax.
 *
 * Note: This module MUST NOT depend on any internal @tianji/* packages.
 */

import { constants as fsConstants } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

// ============================================================================
// Environment Placeholder Utilities
// ============================================================================

/**
 * Placeholder pattern for environment variable references.
 * Syntax: ${env:VAR_NAME}
 */
export const ENV_PLACEHOLDER_PATTERN = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/

/**
 * Configuration error thrown when placeholder resolution fails.
 */
export class ConfigPlaceholderError extends Error {
  constructor(
    public readonly varName: string,
    message: string
  ) {
    super(message)
    this.name = 'ConfigPlaceholderError'
  }
}

/**
 * Checks if a string value is an environment placeholder.
 *
 * @param value - The string value to check
 * @returns true if the value matches the placeholder pattern `${env:VAR_NAME}`
 */
export function isEnvPlaceholder(value: string): boolean {
  return ENV_PLACEHOLDER_PATTERN.test(value)
}

/**
 * Extracts the environment variable name from a placeholder string.
 *
 * @param value - The placeholder string (e.g., "${env:OPENAI_API_KEY}")
 * @returns The variable name, or null if not a valid placeholder
 */
export function extractEnvVarName(value: string): string | null {
  const match = value.match(ENV_PLACEHOLDER_PATTERN)
  return match ? match[1] : null
}

/**
 * Environment resolver function type.
 * Returns the environment variable value or undefined if not set.
 */
export type EnvResolver = (varName: string) => string | undefined

/**
 * Default environment resolver using process.env.
 * Safe for Node.js environments.
 */
export const defaultEnvResolver: EnvResolver = (varName: string) => process.env[varName]

/**
 * Resolves an environment placeholder to its actual value.
 *
 * Rules:
 * - Only resolves values that match the placeholder pattern exactly
 * - Returns the original value if it's not a placeholder
 * - Throws ConfigPlaceholderError if placeholder references an undefined env var
 * - Empty string env value is treated as resolved (not missing)
 *
 * @param value - The string value to resolve
 * @param resolver - Optional custom environment resolver (defaults to process.env)
 * @returns The resolved string value
 * @throws ConfigPlaceholderError if env var is not defined
 */
export function resolveEnvPlaceholder(
  value: string,
  resolver: EnvResolver = defaultEnvResolver
): string {
  const varName = extractEnvVarName(value)
  if (varName === null) {
    // Not a placeholder, return as-is
    return value
  }

  const envValue = resolver(varName)
  if (envValue === undefined) {
    throw new ConfigPlaceholderError(varName, `Environment variable "${varName}" is not defined`)
  }

  // Empty string is a valid resolved value
  return envValue
}

/**
 * Result of resolving all placeholders in a config object.
 */
export interface ResolvedConfigResult<T> {
  /** The resolved config object with all placeholders replaced */
  config: T
  /** List of env var names that were resolved */
  resolvedVars: string[]
}

/**
 * Recursively resolves all environment placeholders in a config object.
 *
 * Rules:
 * - Only resolves placeholders in string values
 * - Preserves all other value types (numbers, booleans, objects, arrays, null)
 * - Throws on first unresolved placeholder encountered
 * - Empty string env values are treated as resolved
 *
 * @param obj - The config object to resolve
 * @param resolver - Optional custom environment resolver
 * @returns The resolved config object and list of resolved var names
 * @throws ConfigPlaceholderError if any placeholder references an undefined env var
 */
export function resolveConfigPlaceholders<T>(
  obj: T,
  resolver: EnvResolver = defaultEnvResolver
): ResolvedConfigResult<T> {
  const resolvedVars: string[] = []

  function resolveValue(value: unknown): unknown {
    if (typeof value === 'string') {
      const varName = extractEnvVarName(value)
      if (varName !== null) {
        const envValue = resolver(varName)
        if (envValue === undefined) {
          throw new ConfigPlaceholderError(
            varName,
            `Environment variable "${varName}" is not defined`
          )
        }
        resolvedVars.push(varName)
        return envValue
      }
      return value
    }

    if (Array.isArray(value)) {
      return value.map(resolveValue)
    }

    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, val] of Object.entries(value)) {
        result[key] = resolveValue(val)
      }
      return result
    }

    return value
  }

  const config = resolveValue(obj) as T
  return { config, resolvedVars }
}

// ============================================================================
// Zod Schemas for v1 Configuration
// ============================================================================

/**
 * Schema for retry configuration.
 */
export const RetryConfigSchema = z.object({
  maxAttempts: z.number().int().positive().optional(),
  baseDelayMs: z.number().int().nonnegative().optional(),
  maxDelayMs: z.number().int().nonnegative().optional(),
})

export type RetryConfig = z.infer<typeof RetryConfigSchema>

/**
 * Schema for path policy configuration.
 */
export const PathPolicyConfigSchema = z.object({
  forbidDirectories: z.array(z.string()).optional(),
  filenameDenyPatterns: z.array(z.string()).optional(),
})

export type PathPolicyConfig = z.infer<typeof PathPolicyConfigSchema>

/**
 * Schema for tool configuration.
 */
export const ToolConfigSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  maxConcurrency: z.number().int().positive().optional(),
  allowDestructive: z.boolean().optional(),
  pathPolicy: PathPolicyConfigSchema.optional(),
})

export type ToolConfigConfig = z.infer<typeof ToolConfigSchema>

/**
 * Schema for runtime configuration.
 */
export const RuntimeConfigSchema = z.object({
  retry: RetryConfigSchema.optional(),
  tool: ToolConfigSchema.optional(),
})

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>

/**
 * Safe agent name pattern used by both config schema and file path helpers.
 */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/

function getAgentNameValidationError(agentName: string): string | null {
  if (!AGENT_NAME_PATTERN.test(agentName)) {
    return `Agent name "${agentName}" must match ${AGENT_NAME_PATTERN}`
  }

  return null
}

function getAgentModelRefValidationError(modelRef: string): string | null {
  const slashIndex = modelRef.indexOf('/')

  if (slashIndex === -1) {
    return 'agents.items.<name>.model must include "/" and use "provider/modelName" format'
  }

  if (slashIndex === 0) {
    return 'agents.items.<name>.model must include a provider before "/"'
  }

  if (slashIndex === modelRef.length - 1) {
    return 'agents.items.<name>.model must include a model name after "/"'
  }

  return null
}

/**
 * Schema for a single provider connection configuration.
 */
export const TianjiProviderConfigSchema = z
  .object({
    apiKey: z.string().optional(),
    // Allow additional provider-specific options
  })
  .passthrough()

export type TianjiProviderConfig = z.infer<typeof TianjiProviderConfigSchema>

/**
 * Schema for provider configuration map.
 */
export const TianjiProvidersConfigSchema = z.record(z.string(), TianjiProviderConfigSchema)

export type TianjiProvidersConfig = z.infer<typeof TianjiProvidersConfigSchema>

/**
 * Schema for the `provider/modelName` model reference string.
 */
export const AgentModelRefSchema = z
  .string()
  .refine((value) => getAgentModelRefValidationError(value) === null, {
    message: 'agents.items.<name>.model must use "provider/modelName" format',
  })

export type AgentModelRef = z.infer<typeof AgentModelRefSchema>

/**
 * Schema for a single agent configuration.
 */
export const TianjiAgentConfigSchema = z.object({
  model: AgentModelRefSchema,
})

export type TianjiAgentConfig = z.infer<typeof TianjiAgentConfigSchema>

/**
 * Schema for the agent configuration collection.
 */
export const TianjiAgentsConfigSchema = z.object({
  defaultAgent: z
    .string()
    .refine((value) => getAgentNameValidationError(value) === null, {
      message: `Agent names must match ${AGENT_NAME_PATTERN}`,
    })
    .optional(),
  items: z
    .record(
      z.string().refine((value) => getAgentNameValidationError(value) === null, {
        message: `Agent names must match ${AGENT_NAME_PATTERN}`,
      }),
      TianjiAgentConfigSchema
    )
    .optional(),
})

export type TianjiAgentsConfig = z.infer<typeof TianjiAgentsConfigSchema>

/**
 * Schema for observer configuration.
 */
export const ObserverConfigSchema = z.object({
  enabled: z.boolean().optional(),
  redactSecrets: z.boolean().optional(),
})

export type ObserverConfig = z.infer<typeof ObserverConfigSchema>

/**
 * Schema for the top-level tianji-ai configuration.
 *
 * This schema represents the v1 configuration shape as defined in docs/CONFIG_DESIGN.md.
 * All fields are optional to support partial configurations across layers.
 */
export const TianjiConfigSchema = z.object({
  providers: TianjiProvidersConfigSchema.optional(),
  agents: TianjiAgentsConfigSchema.optional(),
  runtime: RuntimeConfigSchema.optional(),
  observer: ObserverConfigSchema.optional(),
})

export type TianjiConfig = z.infer<typeof TianjiConfigSchema>

/**
 * Validates a raw config object against the TianjiConfig schema.
 *
 * @param config - The raw config object to validate
 * @returns The validated and typed config object
 * @throws ZodError if validation fails
 */
export function validateTianjiConfig(config: unknown): TianjiConfig {
  return TianjiConfigSchema.parse(config)
}

/**
 * Safely validates a raw config object, returning a result object.
 *
 * @param config - The raw config object to validate
 * @returns An object with success flag and either data or error
 */
export function safeValidateTianjiConfig(
  config: unknown
): z.SafeParseReturnType<unknown, TianjiConfig> {
  return TianjiConfigSchema.safeParse(config)
}

// ============================================================================
// Default Configuration Values
// ============================================================================

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxAttempts: 2,
  baseDelayMs: 300,
  maxDelayMs: 3000,
}

/**
 * Default path policy configuration.
 */
export const DEFAULT_PATH_POLICY_CONFIG: Required<PathPolicyConfig> = {
  forbidDirectories: ['.git/', 'node_modules/'],
  filenameDenyPatterns: ['^\\.env($|\\.)', '(^|/)id_rsa$'],
}

/**
 * Default tool configuration.
 */
export const DEFAULT_TOOL_CONFIG: Required<Omit<ToolConfigConfig, 'pathPolicy'>> & {
  pathPolicy: Required<PathPolicyConfig>
} = {
  timeoutMs: 120000,
  maxConcurrency: 4,
  allowDestructive: false,
  pathPolicy: DEFAULT_PATH_POLICY_CONFIG,
}

/**
 * Default runtime configuration.
 */
export const DEFAULT_RUNTIME_CONFIG: Required<RuntimeConfig> = {
  retry: DEFAULT_RETRY_CONFIG,
  tool: DEFAULT_TOOL_CONFIG,
}

/**
 * Default observer configuration.
 */
export const DEFAULT_OBSERVER_CONFIG: Required<ObserverConfig> = {
  enabled: true,
  redactSecrets: true,
}

/**
 * Default provider configuration.
 */
export const DEFAULT_PROVIDERS_CONFIG: TianjiProvidersConfig = {
  openai: {
    apiKey: '${env:OPENAI_API_KEY}',
  },
}

/**
 * Default agent configuration.
 */
export const DEFAULT_AGENT_CONFIG: TianjiAgentConfig = {
  model: 'openai/gpt-4.1',
}

/**
 * Default agents configuration.
 */
export const DEFAULT_AGENTS_CONFIG: TianjiAgentsConfig = {
  defaultAgent: 'default',
  items: {
    default: {
      ...DEFAULT_AGENT_CONFIG,
    },
  },
}

/**
 * Full default tianji-ai configuration.
 */
export const DEFAULT_TIANJI_CONFIG: TianjiConfig = {
  providers: DEFAULT_PROVIDERS_CONFIG,
  agents: DEFAULT_AGENTS_CONFIG,
  runtime: DEFAULT_RUNTIME_CONFIG,
  observer: DEFAULT_OBSERVER_CONFIG,
}

/**
 * Creates a fresh default user configuration object that is safe to mutate.
 *
 * This helper is intended for first-run config initialization where callers
 * need a writable object without sharing references to exported default
 * configuration constants.
 *
 * @returns A deep-cloned default Tianji configuration object
 */
export function createDefaultUserTianjiConfig(): TianjiConfig {
  return structuredClone(DEFAULT_TIANJI_CONFIG)
}

/**
 * Parses an agent model reference into provider and model name parts.
 *
 * The parser only splits on the first `/` so that model names can continue to
 * contain nested path segments in the future.
 *
 * @param modelRef - The raw `provider/modelName` reference from config
 * @returns The parsed provider name and model name
 * @throws Error if the reference is missing `/`, provider, or model name
 */
export function parseAgentModelRef(modelRef: string): {
  provider: string
  modelName: string
} {
  const validationError = getAgentModelRefValidationError(modelRef)
  if (validationError !== null) {
    throw new Error(`Invalid agent model reference "${modelRef}": ${validationError}`)
  }

  const slashIndex = modelRef.indexOf('/')

  return {
    provider: modelRef.slice(0, slashIndex),
    modelName: modelRef.slice(slashIndex + 1),
  }
}

/**
 * Resolves the configured default agent definition.
 *
 * This helper centralizes the explicit error semantics needed by higher-level
 * loaders so they do not need to duplicate missing-field checks.
 *
 * @param config - The validated or partially merged Tianji config
 * @returns The default agent name and its resolved configuration object
 * @throws Error if `agents.defaultAgent`, `agents.items`, or the default item is missing
 */
export function getDefaultAgentDefinition(config: TianjiConfig): {
  agentName: string
  agent: TianjiAgentConfig
} {
  const defaultAgent = config.agents?.defaultAgent
  if (defaultAgent === undefined) {
    throw new Error('Missing agents.defaultAgent in Tianji config')
  }

  const agentItems = config.agents?.items
  if (agentItems === undefined) {
    throw new Error('Missing agents.items in Tianji config')
  }

  const agent = agentItems[defaultAgent]
  if (agent === undefined) {
    throw new Error(`Default agent "${defaultAgent}" is not defined in agents.items`)
  }

  return {
    agentName: defaultAgent,
    agent,
  }
}

/**
 * Builds the conventional `SOUL.md` path for a named agent.
 *
 * @param configDir - The root Tianji config directory
 * @param agentName - The agent name that owns the soul file
 * @returns The absolute or relative `agents/<name>/SOUL.md` path
 * @throws Error if the agent name is not a safe filesystem name
 */
export function getAgentSoulPath(configDir: string, agentName: string): string {
  const validationError = getAgentNameValidationError(agentName)
  if (validationError !== null) {
    throw new Error(validationError)
  }

  return join(configDir, 'agents', agentName, 'SOUL.md')
}

/**
 * Loads and validates an agent `SOUL.md` file.
 *
 * The helper ensures the file exists, is readable, and contains at least one
 * non-whitespace character so downstream runtime code can rely on meaningful
 * content.
 *
 * @param filePath - The `SOUL.md` file path to read
 * @returns The raw file contents
 * @throws Error if the file does not exist, is unreadable, or is empty
 */
export async function loadAgentSoul(filePath: string): Promise<string> {
  try {
    await access(filePath, fsConstants.F_OK)
  } catch (error) {
    const errorCode = error instanceof Error && 'code' in error ? error.code : undefined
    if (errorCode === 'ENOENT') {
      throw new Error(`Agent soul file does not exist: ${filePath}`)
    }

    throw new Error(`Agent soul file is not readable: ${filePath}`)
  }

  try {
    await access(filePath, fsConstants.R_OK)
  } catch {
    throw new Error(`Agent soul file is not readable: ${filePath}`)
  }

  const content = await readFile(filePath, 'utf8')
  if (content.trim().length === 0) {
    throw new Error(`Agent soul file is empty: ${filePath}`)
  }

  return content
}
