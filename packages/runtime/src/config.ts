import { createHash } from 'node:crypto'
import { accessSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ConfigPlaceholderError,
  type TianjiConfig,
  resolveConfigPlaceholders,
  safeValidateTianjiConfig,
} from '@tianji/shared'

export type ConfigLayerName = 'default' | 'user' | 'workspace'

export type RuntimeConfigErrorCode =
  | 'config.parse_error'
  | 'config.schema_error'
  | 'config.placeholder_error'
  | 'config.env_missing'
  | 'config.workspace_resolution_error'

export interface ResolvedConfigPaths {
  readonly workspaceRoot: string
  readonly defaultConfigPath: string
  readonly userConfigDir: string
  readonly userConfigPath: string
  readonly workspacesConfigDir: string
  readonly workspaceConfigPath: string
}

export interface WorkspaceConfigResolution {
  readonly root: string
  readonly normalizedRoot: string
  readonly id: string
}

export interface ConfigLayerSnapshot {
  readonly name: ConfigLayerName
  readonly filePath: string
  readonly exists: boolean
  readonly config?: TianjiConfig
}

export interface ResolvedConfig {
  readonly config: TianjiConfig
  readonly resolvedEnvVars: readonly string[]
  readonly paths: ResolvedConfigPaths
  readonly workspace: WorkspaceConfigResolution
  readonly layers: readonly ConfigLayerSnapshot[]
}

export interface LoadResolvedConfigOptions {
  readonly workspaceRoot?: string
  readonly userHomeDir?: string
}

interface ParsedConfigFileResult {
  readonly exists: boolean
  readonly config?: TianjiConfig
}

const RUNTIME_MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG_FILE_NAME = 'tianji.config.json'

/**
 * Runtime-scoped configuration error with stable error codes and source
 * metadata so apps can report precise diagnostics.
 */
export class RuntimeConfigError extends Error {
  constructor(
    public readonly code: RuntimeConfigErrorCode,
    message: string,
    public readonly details: {
      readonly layer?: ConfigLayerName
      readonly filePath?: string
      readonly fieldPath?: string
      readonly phase?: 'workspace_resolution' | 'parse' | 'schema' | 'placeholder'
      readonly cause?: unknown
    } = {}
  ) {
    super(message)
    this.name = 'RuntimeConfigError'
  }
}

/**
 * Resolves the runtime config file paths for the current workspace.
 *
 * @param options - Optional path overrides for tests or embedding hosts
 * @returns The resolved path set used by the runtime loader
 */
export function resolveConfigPaths(options: LoadResolvedConfigOptions = {}): ResolvedConfigPaths {
  const workspace = resolveWorkspaceConfig(options)
  const userConfigDir = join(resolveUserHomeDir(options), '.config', 'tianji-ai')
  const workspacesConfigDir = join(userConfigDir, 'workspaces')

  return {
    workspaceRoot: workspace.root,
    defaultConfigPath: resolveDefaultConfigPath(),
    userConfigDir,
    userConfigPath: join(userConfigDir, 'tianji.json'),
    workspacesConfigDir,
    workspaceConfigPath: join(workspacesConfigDir, `${workspace.id}.json`),
  }
}

/**
 * Resolves the workspace identity used by workspace-scoped config files.
 *
 * @param options - Optional workspace root and user home overrides
 * @returns The normalized workspace metadata used by the config center
 */
export function resolveWorkspaceConfig(
  options: LoadResolvedConfigOptions = {}
): WorkspaceConfigResolution {
  const root = resolveWorkspaceRoot(options.workspaceRoot)
  const normalizedRoot = normalize(root)

  return {
    root,
    normalizedRoot,
    id: createWorkspaceId(normalizedRoot),
  }
}

/**
 * Creates a stable filesystem-safe workspace id from a normalized absolute
 * workspace path.
 *
 * @param normalizedWorkspaceRoot - The normalized absolute workspace path
 * @returns A stable short hash suitable for config file names
 */
export function createWorkspaceId(normalizedWorkspaceRoot: string): string {
  return createHash('sha256').update(normalizedWorkspaceRoot).digest('hex').slice(0, 16)
}

/**
 * Loads, merges, validates, and resolves the full runtime configuration across
 * default, user, and workspace layers.
 *
 * @param options - Optional workspace and home directory overrides
 * @returns The final resolved config plus diagnostics metadata
 */
export async function loadResolvedConfig(
  options: LoadResolvedConfigOptions = {}
): Promise<ResolvedConfig> {
  const workspace = resolveWorkspaceConfig(options)
  const paths = resolveConfigPaths(options)

  const defaultLayer = await readConfigLayer('default', paths.defaultConfigPath)
  const userLayer = await readConfigLayer('user', paths.userConfigPath)
  const workspaceLayer = await readConfigLayer('workspace', paths.workspaceConfigPath)

  const mergedConfig = mergeTianjiConfigLayers(
    defaultLayer.config ?? {},
    userLayer.config ?? {},
    workspaceLayer.config ?? {}
  )
  const resolution = resolveMergedConfig(mergedConfig)

  return {
    config: resolution.config,
    resolvedEnvVars: resolution.resolvedEnvVars,
    paths,
    workspace,
    layers: [
      toLayerSnapshot('default', paths.defaultConfigPath, defaultLayer),
      toLayerSnapshot('user', paths.userConfigPath, userLayer),
      toLayerSnapshot('workspace', paths.workspaceConfigPath, workspaceLayer),
    ],
  }
}

/**
 * Resolves the built-in default config file path for both source and packaged
 * runtime layouts.
 *
 * @returns The absolute path to the bundled default config file
 */
export function resolveDefaultConfigPath(): string {
  return resolveRuntimeRootDir()
}

function resolveRuntimeRootDir(): string {
  for (const candidateDir of getDefaultConfigSearchDirs()) {
    const candidatePath = join(candidateDir, DEFAULT_CONFIG_FILE_NAME)
    try {
      accessSync(candidatePath)
      return candidatePath
    } catch {
      // Try the next candidate directory.
    }
  }

  return join(normalize(resolve(RUNTIME_MODULE_DIR, '..')), DEFAULT_CONFIG_FILE_NAME)
}

function getDefaultConfigSearchDirs(): readonly string[] {
  const packageRootDir = normalize(resolve(RUNTIME_MODULE_DIR, '..'))
  const workspaceRootDir = normalize(resolve(RUNTIME_MODULE_DIR, '../../..'))

  return [workspaceRootDir, packageRootDir]
}

function mergeTianjiConfigLayers(...layers: readonly TianjiConfig[]): TianjiConfig {
  let merged: unknown = {}

  for (const layer of layers) {
    merged = mergeConfigValue(merged, layer)
  }

  return merged as TianjiConfig
}

function mergeConfigValue(base: unknown, override: unknown): unknown {
  if (override === undefined) {
    return cloneConfigValue(base)
  }

  if (Array.isArray(override)) {
    return cloneConfigValue(override)
  }

  if (isPlainObject(override)) {
    const baseRecord = isPlainObject(base) ? base : {}
    const result: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(baseRecord)) {
      result[key] = cloneConfigValue(value)
    }

    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) {
        continue
      }

      result[key] = mergeConfigValue(baseRecord[key], value)
    }

    return result
  }

  return cloneConfigValue(override)
}

function cloneConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneConfigValue)
  }

  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {}

    for (const [key, entry] of Object.entries(value)) {
      result[key] = cloneConfigValue(entry)
    }

    return result
  }

  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function resolveWorkspaceRoot(workspaceRoot: string | undefined): string {
  try {
    const candidate = workspaceRoot ?? process.cwd()
    return isAbsolute(candidate) ? normalize(candidate) : normalize(resolve(candidate))
  } catch (error) {
    throw new RuntimeConfigError(
      'config.workspace_resolution_error',
      `Failed to resolve workspace root: ${getErrorMessage(error)}`,
      {
        phase: 'workspace_resolution',
        cause: error,
      }
    )
  }
}

function resolveUserHomeDir(options: LoadResolvedConfigOptions): string {
  const homeDir = options.userHomeDir ?? homedir()
  if (homeDir.length === 0) {
    throw new RuntimeConfigError(
      'config.workspace_resolution_error',
      'Failed to resolve user home directory for config lookup',
      {
        phase: 'workspace_resolution',
      }
    )
  }

  return homeDir
}

async function readConfigLayer(
  layer: ConfigLayerName,
  filePath: string
): Promise<ParsedConfigFileResult> {
  let content: string

  try {
    content = await readFile(filePath, 'utf8')
  } catch (error) {
    const errorCode = error instanceof Error && 'code' in error ? error.code : undefined
    if (errorCode === 'ENOENT') {
      return { exists: false }
    }

    throw new RuntimeConfigError(
      'config.parse_error',
      `Failed to read ${layer} config at ${filePath}: ${getErrorMessage(error)}`,
      {
        layer,
        filePath,
        phase: 'parse',
        cause: error,
      }
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new RuntimeConfigError(
      'config.parse_error',
      `Failed to parse ${layer} config JSON at ${filePath}: ${getErrorMessage(error)}`,
      {
        layer,
        filePath,
        phase: 'parse',
        cause: error,
      }
    )
  }

  const validationResult = safeValidateTianjiConfig(parsed)
  if (!validationResult.success) {
    const issue = validationResult.error.issues[0]
    const fieldPath = issue?.path.join('.') || undefined

    throw new RuntimeConfigError(
      'config.schema_error',
      `Invalid ${layer} config at ${filePath}: ${validationResult.error.message}`,
      {
        layer,
        filePath,
        fieldPath,
        phase: 'schema',
        cause: validationResult.error,
      }
    )
  }

  return {
    exists: true,
    config: validationResult.data,
  }
}

function resolveMergedConfig(config: TianjiConfig): {
  readonly config: TianjiConfig
  readonly resolvedEnvVars: readonly string[]
} {
  let result: {
    readonly config: TianjiConfig
    readonly resolvedVars: string[]
  }

  try {
    result = resolveConfigPlaceholders(config)
  } catch (error) {
    if (error instanceof ConfigPlaceholderError) {
      throw new RuntimeConfigError(
        'config.env_missing',
        `Failed to resolve environment variable "${error.varName}" in config`,
        {
          fieldPath: error.varName,
          phase: 'placeholder',
          cause: error,
        }
      )
    }

    throw new RuntimeConfigError(
      'config.placeholder_error',
      `Failed to resolve config placeholders: ${getErrorMessage(error)}`,
      {
        phase: 'placeholder',
        cause: error,
      }
    )
  }

  validateResolvedRuntimeConfig(result.config)

  return {
    config: result.config,
    resolvedEnvVars: result.resolvedVars,
  }
}

function validateResolvedRuntimeConfig(config: TianjiConfig): void {
  const langsmith = config.runtime?.tracing?.langsmith
  if (langsmith?.enabled !== true) {
    return
  }

  const missingFields: string[] = []

  if (langsmith.project === undefined || langsmith.project.length === 0) {
    missingFields.push('runtime.tracing.langsmith.project')
  }

  if (langsmith.apiKey === undefined || langsmith.apiKey.length === 0) {
    missingFields.push('runtime.tracing.langsmith.apiKey')
  }

  if (missingFields.length === 0) {
    return
  }

  throw new RuntimeConfigError(
    'config.schema_error',
    `Invalid merged runtime config: ${missingFields.join(', ')} ${missingFields.length === 1 ? 'is' : 'are'} required when LangSmith tracing is enabled`,
    {
      fieldPath: missingFields[0],
      phase: 'schema',
    }
  )
}

function toLayerSnapshot(
  name: ConfigLayerName,
  filePath: string,
  result: ParsedConfigFileResult
): ConfigLayerSnapshot {
  return {
    name,
    filePath,
    exists: result.exists,
    config: result.config,
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
