/**
 * @tianji/shared - Configuration Schema and Placeholder Resolution
 *
 * This module provides Zod schemas for tianji-ai configuration and
 * environment variable placeholder parsing for `${env:VAR_NAME}` syntax.
 *
 * Note: This module MUST NOT depend on any internal @tianji/* packages.
 */

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
		message: string,
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
export const defaultEnvResolver: EnvResolver = (varName: string) =>
	process.env[varName]

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
	resolver: EnvResolver = defaultEnvResolver,
): string {
	const varName = extractEnvVarName(value)
	if (varName === null) {
		// Not a placeholder, return as-is
		return value
	}

	const envValue = resolver(varName)
	if (envValue === undefined) {
		throw new ConfigPlaceholderError(
			varName,
			`Environment variable "${varName}" is not defined`,
		)
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
	resolver: EnvResolver = defaultEnvResolver,
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
						`Environment variable "${varName}" is not defined`,
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
 * Schema for a single LLM provider configuration.
 */
export const LlmProviderConfigSchema = z.object({
	apiKey: z.string().optional(),
	// Allow additional provider-specific options
}).passthrough()

export type LlmProviderConfig = z.infer<typeof LlmProviderConfigSchema>

/**
 * Schema for LLM providers map.
 */
export const LlmProvidersConfigSchema = z.record(z.string(), LlmProviderConfigSchema)

export type LlmProvidersConfig = z.infer<typeof LlmProvidersConfigSchema>

/**
 * Schema for LLM configuration.
 */
export const LlmConfigSchema = z.object({
	defaultProvider: z.string().optional(),
	defaultModel: z.string().optional(),
	providers: LlmProvidersConfigSchema.optional(),
})

export type LlmConfig = z.infer<typeof LlmConfigSchema>

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
	llm: LlmConfigSchema.optional(),
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
	config: unknown,
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
 * Default LLM configuration.
 */
export const DEFAULT_LLM_CONFIG: LlmConfig = {
	defaultProvider: undefined,
	defaultModel: undefined,
	providers: {},
}

/**
 * Full default tianji-ai configuration.
 */
export const DEFAULT_TIANJI_CONFIG: TianjiConfig = {
	llm: DEFAULT_LLM_CONFIG,
	runtime: DEFAULT_RUNTIME_CONFIG,
	observer: DEFAULT_OBSERVER_CONFIG,
}
