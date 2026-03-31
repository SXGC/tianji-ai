/**
 * @tianji/shared - Shared utilities and configuration schemas
 *
 * This package provides common utilities and configuration schemas
 * used across tianji-ai packages.
 *
 * Note: This package MUST NOT depend on any internal @tianji/* packages.
 * External utility dependencies (e.g., zod, type-fest) are allowed.
 */

// Configuration Schema and Placeholder Resolution
export {
  // Placeholder utilities
  ENV_PLACEHOLDER_PATTERN,
  ConfigPlaceholderError,
  type EnvResolver,
  defaultEnvResolver,
  isEnvPlaceholder,
  extractEnvVarName,
  resolveEnvPlaceholder,
  resolveConfigPlaceholders,
  type ResolvedConfigResult,
  // Zod schemas
  RetryConfigSchema,
  type RetryConfig,
  PathPolicyConfigSchema,
  type PathPolicyConfig,
  ToolConfigSchema,
  type ToolConfigConfig,
  RuntimeConfigSchema,
  type RuntimeConfig,
  AGENT_NAME_PATTERN,
  TianjiProviderConfigSchema,
  type TianjiProviderConfig,
  TianjiProvidersConfigSchema,
  type TianjiProvidersConfig,
  AgentModelRefSchema,
  type AgentModelRef,
  TianjiAgentConfigSchema,
  type TianjiAgentConfig,
  TianjiAgentsConfigSchema,
  type TianjiAgentsConfig,
  ObserverConfigSchema,
  type ObserverConfig,
  TianjiConfigSchema,
  type TianjiConfig,
  // Validation functions
  validateTianjiConfig,
  safeValidateTianjiConfig,
  mergeTianjiConfigLayers,
  // Default configurations
  DEFAULT_RETRY_CONFIG,
  DEFAULT_PATH_POLICY_CONFIG,
  DEFAULT_TOOL_CONFIG,
  DEFAULT_RUNTIME_CONFIG,
  DEFAULT_OBSERVER_CONFIG,
  DEFAULT_PROVIDERS_CONFIG,
  DEFAULT_AGENT_CONFIG,
  DEFAULT_AGENTS_CONFIG,
  DEFAULT_TIANJI_CONFIG,
  // Agent helpers
  createDefaultUserTianjiConfig,
  parseAgentModelRef,
  getDefaultAgentDefinition,
  getAgentSoulPath,
  loadAgentSoul,
} from './config.js'

export * from './artifact.js'
export * from './delta-aggregator.js'
export * from './delta.js'
export * from './errors.js'
export * from './events.js'
export * from './identifiers.js'
export * from './message.js'
export * from './policy.js'
export * from './snapshot.js'
export * from './tool.js'

export type { RunSnapshot, RunStatus, RunTriggerType } from './snapshot.js'

// General-purpose utilities
export {
  deepClone,
  sleep,
  retry,
  type RetryOptions,
  DEFAULT_RETRY_OPTIONS,
} from './utils.js'
