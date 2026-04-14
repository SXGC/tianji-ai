import { access, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { FileSnapshotStore, loadResolvedConfig } from '@tianji/runtime'
import {
  type TianjiConfig,
  type TianjiProviderConfig,
  getAgentSoulPath,
  getDefaultAgentDefinition,
  loadAgentSoul,
  parseAgentModelRef,
} from '@tianji/shared'

const PROVIDER_ENV_KEY_MAP: Readonly<Record<string, readonly string[]>> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY'],
}

const DEFAULT_AGENT_SOUL_MARKDOWN = `# Default Tianji Agent

You are the default Tianji agent.

- Be concise.
- Be direct.
- Be practical.
`

const DEFAULT_AGENT_NAME = 'default'

/** 单节点默认编排图：一个 agent 节点引用 defaultAgent，__start__ → agent → __end__ */
const DEFAULT_ORCHESTRATION_GRAPH = {
  id: 'default',
  name: 'default',
  version: 1,
  source: 'static',
  locked: false,
  state: {
    input: { type: 'string' },
    output: { type: 'string' },
  },
  nodes: [
    {
      id: 'agent',
      type: 'agent',
      agent: 'default',
      input: ['input'],
      output: ['output'],
    },
  ],
  edges: [
    { from: '__start__', to: 'agent' },
    { from: 'agent', to: '__end__' },
  ],
} as const

export interface AgentAppPaths {
  readonly configDir: string
  readonly agentsDir: string
  readonly logsDir: string
  readonly configFilePath: string
  readonly cliLogFilePath: string
  readonly daemonPortPath: string
  readonly daemonPidPath: string
}

export interface AgentContext {
  readonly agentName: string
  readonly modelRef: string
  readonly provider: string
  readonly modelName: string
  readonly providerConfig: TianjiProviderConfig | undefined
  readonly soulPath: string
  readonly soul: string
  readonly workspace: string | undefined
}

export interface LoadedAgentContext {
  readonly paths: AgentAppPaths
  readonly config: TianjiConfig
  readonly agent: AgentContext
  readonly resolvedEnvVars: readonly string[]
  readonly snapshotStore: FileSnapshotStore
}

export function getUserTianjiConfigDir(): string {
  return join(homedir(), '.config', 'tianji-ai')
}

export function getUserAgentsDir(): string {
  return join(getUserTianjiConfigDir(), 'agents')
}

export function getUserLogsDir(): string {
  return join(getUserTianjiConfigDir(), 'logs')
}

export function getUserTianjiConfigPath(): string {
  return join(getUserTianjiConfigDir(), 'tianji.json')
}

export function getAgentAppPaths(): AgentAppPaths {
  const configDir = getUserTianjiConfigDir()
  const agentsDir = getUserAgentsDir()
  const logsDir = getUserLogsDir()

  return {
    configDir,
    agentsDir,
    logsDir,
    configFilePath: getUserTianjiConfigPath(),
    cliLogFilePath: join(logsDir, 'tianji.log'),
    daemonPortPath: join(configDir, 'daemon.port'),
    daemonPidPath: join(configDir, 'daemon.pid'),
  }
}

/**
 * Ensures the first-run user config scaffold exists for the current machine.
 *
 * @param paths - Optional pre-resolved application paths
 * @returns Stable user config paths for later runtime bootstrap
 */
export async function ensureDefaultUserConfig(
  paths: AgentAppPaths = getAgentAppPaths()
): Promise<AgentAppPaths> {
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

  const orchestrationPath = join(paths.configDir, 'default-orchestration.json')
  if (!(await pathExists(orchestrationPath))) {
    const graph = {
      ...DEFAULT_ORCHESTRATION_GRAPH,
      nodes: [
        {
          id: 'agent',
          type: 'agent',
          agent: defaultAgentName,
          input: ['input'],
          output: ['output'],
        },
      ],
    }
    await writeFile(orchestrationPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8')
  }

  return paths
}

/**
 * Loads resolved config plus agent-facing runtime bootstrap context.
 *
 * @returns The current agent selection, resolved config, and snapshot store
 */
export async function loadAgentContext(): Promise<LoadedAgentContext> {
  const paths = await ensureDefaultUserConfig()
  const resolvedConfig = await loadResolvedConfig()
  const { agentName } = getDefaultAgentDefinition(resolvedConfig.config)
  return createLoadedAgentContext({
    paths,
    config: resolvedConfig.config,
    resolvedEnvVars: resolvedConfig.resolvedEnvVars,
    snapshotStore: new FileSnapshotStore(join(paths.configDir, 'runtime-snapshots')),
    agentName,
  })
}

/**
 * Creates an isolated agent view from an existing loaded context.
 *
 * @param agentName - The configured agent name to load
 * @param baseContext - Shared daemon bootstrap context
 * @returns A context with shared infrastructure and agent-specific config
 */
export async function loadAgentContextForName(
  agentName: string,
  baseContext: LoadedAgentContext
): Promise<LoadedAgentContext> {
  const agentItems = baseContext.config.agents?.items
  if (agentItems === undefined) {
    throw new Error(`Agent "${agentName}" not found in config.agents.items`)
  }

  const agentConfig = {
    ...baseContext.config,
    agents: {
      ...baseContext.config.agents,
      defaultAgent: agentName,
      items: {
        ...agentItems,
      },
    },
  }

  return createLoadedAgentContext({
    paths: baseContext.paths,
    config: agentConfig,
    resolvedEnvVars: baseContext.resolvedEnvVars,
    snapshotStore: baseContext.snapshotStore,
    agentName,
  })
}

export function injectProviderEnv(context: LoadedAgentContext): void {
  const envKeys = PROVIDER_ENV_KEY_MAP[context.agent.provider]
  const apiKey = context.agent.providerConfig?.apiKey

  if (envKeys === undefined || typeof apiKey !== 'string' || apiKey.length === 0) {
    return
  }

  for (const envKey of envKeys) {
    process.env[envKey] = apiKey
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

function readDefaultAgentName(config: TianjiConfig): string {
  return config.agents?.defaultAgent ?? DEFAULT_AGENT_NAME
}

async function createLoadedAgentContext(input: {
  paths: AgentAppPaths
  config: TianjiConfig
  resolvedEnvVars: readonly string[]
  snapshotStore: FileSnapshotStore
  agentName: string
}): Promise<LoadedAgentContext> {
  const agent = input.config.agents?.items?.[input.agentName]
  if (agent === undefined) {
    throw new Error(`Agent "${input.agentName}" not found in config.agents.items`)
  }

  if (agent.model === undefined) {
    throw new Error(
      `Agent "${input.agentName}" must have a "model" field for native agent execution`
    )
  }

  const { provider, modelName } = parseAgentModelRef(agent.model)
  const soulPath = getAgentSoulPath(input.paths.configDir, input.agentName)
  const soul = await loadAgentSoul(soulPath)

  return {
    paths: input.paths,
    config: input.config,
    agent: {
      agentName: input.agentName,
      modelRef: agent.model,
      provider,
      modelName,
      providerConfig: input.config.providers?.[provider],
      soulPath,
      soul,
      workspace: agent.workspace,
    },
    resolvedEnvVars: input.resolvedEnvVars,
    snapshotStore: input.snapshotStore,
  }
}
