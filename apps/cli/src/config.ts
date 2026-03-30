import { access, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadResolvedConfig } from '@tianji/runtime'
import {
  type TianjiConfig,
  type TianjiProviderConfig,
  getAgentSoulPath,
  getDefaultAgentDefinition,
  loadAgentSoul,
  parseAgentModelRef,
} from '@tianji/shared'

const PROVIDER_ENV_KEY_MAP: Readonly<Record<string, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
}

const DEFAULT_AGENT_SOUL_MARKDOWN = `# Default Tianji Agent

You are the default Tianji agent.

- Be concise.
- Be direct.
- Be practical.
`

const DEFAULT_AGENT_NAME = 'default'

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
 * The initializer creates the config root, `agents/`, `logs/`, an empty
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
    await writeFile(paths.configFilePath, '{}\n', 'utf8')
  }

  const resolvedConfig = await loadResolvedConfig()
  const defaultAgentName = readDefaultAgentName(resolvedConfig.config)
  const defaultSoulPath = getAgentSoulPath(paths.configDir, defaultAgentName)

  await mkdir(dirname(defaultSoulPath), { recursive: true })
  if (!(await pathExists(defaultSoulPath))) {
    await writeFile(defaultSoulPath, DEFAULT_AGENT_SOUL_MARKDOWN, 'utf8')
  }

  return paths
}

/**
 * Loads the runtime-resolved config, then enriches it with CLI-specific file
 * paths and SOUL.md content required by later bootstrap stages.
 *
 * @returns The structured user config context for CLI execution
 */
export async function loadUserConfigContext(): Promise<LoadedUserConfigContext> {
  const paths = await ensureDefaultUserConfig()
  const resolvedConfig = await loadResolvedConfig()
  const { agentName, agent } = getDefaultAgentDefinition(resolvedConfig.config)
  const { provider, modelName } = parseAgentModelRef(agent.model)
  const soulPath = getAgentSoulPath(paths.configDir, agentName)
  const soul = await loadAgentSoul(soulPath)

  return {
    paths,
    config: resolvedConfig.config,
    agent: {
      agentName,
      modelRef: agent.model,
      provider,
      modelName,
      providerConfig: resolvedConfig.config.providers?.[provider],
      soulPath,
      soul,
    },
    resolvedEnvVars: resolvedConfig.resolvedEnvVars,
  }
}

/**
 * 将已解析的 provider apiKey 映射到 process.env，使底层 LLM SDK 能自动读取。
 *
 * 仅处理 PROVIDER_ENV_KEY_MAP 中已知的 provider，不存在的 provider 静默跳过。
 *
 * @param context - 已加载并完成 placeholder 解析的用户配置上下文
 */
export function injectProviderEnv(context: LoadedUserConfigContext): void {
  const envKey = PROVIDER_ENV_KEY_MAP[context.agent.provider]
  const apiKey = context.agent.providerConfig?.apiKey

  if (envKey === undefined || typeof apiKey !== 'string' || apiKey.length === 0) {
    return
  }

  process.env[envKey] = apiKey
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function readDefaultAgentName(config: TianjiConfig): string {
  return config.agents?.defaultAgent ?? DEFAULT_AGENT_NAME
}
