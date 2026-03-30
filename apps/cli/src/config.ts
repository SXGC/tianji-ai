import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type TianjiConfig,
  type TianjiProviderConfig,
  createDefaultUserTianjiConfig,
  getAgentSoulPath,
  getDefaultAgentDefinition,
  loadAgentSoul,
  parseAgentModelRef,
  resolveConfigPlaceholders,
  safeValidateTianjiConfig,
} from '@tianji/shared'

const DEFAULT_AGENT_SOUL_MARKDOWN = `# Default Tianji Agent

You are the default Tianji agent.

- Be concise.
- Be direct.
- Be practical.
`

export interface UserConfigPaths {
  readonly configDir: string
  readonly agentsDir: string
  readonly logsDir: string
  readonly configFilePath: string
  readonly cliLogFilePath: string
}

export interface LoadedAgentConfig {
  readonly agentName: string
  readonly modelRef: string
  readonly provider: string
  readonly modelName: string
  readonly providerConfig: TianjiProviderConfig | undefined
  readonly soulPath: string
  readonly soul: string
}

export interface LoadedUserConfigContext {
  readonly paths: UserConfigPaths
  readonly config: TianjiConfig
  readonly agent: LoadedAgentConfig
  readonly resolvedEnvVars: readonly string[]
}

/**
 * Returns the conventional Tianji user config directory.
 *
 * @returns The absolute `~/.config/tianji-ai` path
 */
export function getUserTianjiConfigDir(): string {
  return join(homedir(), '.config', 'tianji-ai')
}

/**
 * Returns the root directory that stores user agent definitions.
 *
 * @returns The absolute `agents/` directory path
 */
export function getUserAgentsDir(): string {
  return join(getUserTianjiConfigDir(), 'agents')
}

/**
 * Returns the root directory that stores CLI logs.
 *
 * @returns The absolute `logs/` directory path
 */
export function getUserLogsDir(): string {
  return join(getUserTianjiConfigDir(), 'logs')
}

/**
 * Returns the user Tianji config file path.
 *
 * @returns The absolute `tianji.json` path
 */
export function getUserTianjiConfigPath(): string {
  return join(getUserTianjiConfigDir(), 'tianji.json')
}

/**
 * Returns the structured path collection used by CLI modules.
 *
 * @returns Stable absolute paths for config, agents, logs, and CLI log file
 */
export function getUserConfigPaths(): UserConfigPaths {
  const configDir = getUserTianjiConfigDir()
  const agentsDir = getUserAgentsDir()
  const logsDir = getUserLogsDir()

  return {
    configDir,
    agentsDir,
    logsDir,
    configFilePath: getUserTianjiConfigPath(),
    cliLogFilePath: join(logsDir, 'cli.jsonl'),
  }
}

/**
 * Ensures the first-run user config scaffold exists.
 *
 * The initializer creates the config root, `agents/`, `logs/`, a default
 * `tianji.json`, and the default agent `SOUL.md` when they are missing.
 * Existing user files are preserved.
 *
 * @returns The resolved user config paths
 */
export async function ensureDefaultUserConfig(): Promise<UserConfigPaths> {
  const paths = getUserConfigPaths()
  await mkdir(paths.configDir, { recursive: true })
  await mkdir(paths.agentsDir, { recursive: true })
  await mkdir(paths.logsDir, { recursive: true })

  if (!(await pathExists(paths.configFilePath))) {
    const defaultConfig = createDefaultUserTianjiConfig()
    await writeFile(paths.configFilePath, `${JSON.stringify(defaultConfig, null, 2)}\n`, 'utf8')
  }

  const defaultAgentDefinition = getDefaultAgentDefinition(createDefaultUserTianjiConfig())
  const defaultSoulPath = getAgentSoulPath(paths.configDir, defaultAgentDefinition.agentName)

  await mkdir(dirname(defaultSoulPath), { recursive: true })
  if (!(await pathExists(defaultSoulPath))) {
    await writeFile(defaultSoulPath, DEFAULT_AGENT_SOUL_MARKDOWN, 'utf8')
  }

  return paths
}

/**
 * Loads the user config, resolves placeholders, and returns the default agent
 * context required by later runtime bootstrap stages.
 *
 * @returns The structured user config context for CLI execution
 */
export async function loadUserConfigContext(): Promise<LoadedUserConfigContext> {
  const paths = await ensureDefaultUserConfig()
  const configContent = await readFile(paths.configFilePath, 'utf8')

  let parsedConfig: unknown
  try {
    parsedConfig = JSON.parse(configContent)
  } catch (error) {
    throw new Error(
      `Failed to parse user config JSON at ${paths.configFilePath}: ${getErrorMessage(error)}`
    )
  }

  const validationResult = safeValidateTianjiConfig(parsedConfig)
  if (!validationResult.success) {
    throw new Error(
      `Invalid user config at ${paths.configFilePath}: ${validationResult.error.message}`
    )
  }

  const { config, resolvedVars } = resolveConfigPlaceholders(validationResult.data)
  const { agentName, agent } = getDefaultAgentDefinition(config)
  const { provider, modelName } = parseAgentModelRef(agent.model)
  const soulPath = getAgentSoulPath(paths.configDir, agentName)
  const soul = await loadAgentSoul(soulPath)

  return {
    paths,
    config,
    agent: {
      agentName,
      modelRef: agent.model,
      provider,
      modelName,
      providerConfig: config.providers?.[provider],
      soulPath,
      soul,
    },
    resolvedEnvVars: resolvedVars,
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
