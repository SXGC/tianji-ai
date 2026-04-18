import type { AgentSession, LoadedAgentContext, UnifiedRuntimeEntry } from '@tianji/agent'
import type { TianjiConfig } from '@tianji/shared'

import type { UserConfigPaths } from '../config.js'
import type { DaemonHandle } from '../daemon-entry.js'
import type { I18n, MessageKey } from '../i18n/index.js'
import type { FollowCliLogOptions } from '../log-follow.js'
import type {
  ControlPlaneRuntimeConfig,
  ControlPlaneRuntimeHandle,
} from '../node-runtime/controlplane-runtime.js'

/**
 * 所有 CLI 命令共用的可注入依赖。
 */
export interface CliDependencies {
  readonly loadContext?: () => Promise<LoadedAgentContext>
  readonly createSession?: (context: LoadedAgentContext) => AgentSession
  readonly createUnifiedEntry?: (context: LoadedAgentContext) => Promise<UnifiedRuntimeEntry>
  readonly getUserConfigPaths?: () => UserConfigPaths
  readonly followCliLog?: (
    logFilePath: string,
    i18n: I18n,
    options?: FollowCliLogOptions
  ) => Promise<void>
  readonly createControlPlaneRuntime?: (
    config: ControlPlaneRuntimeConfig
  ) => ControlPlaneRuntimeHandle
  readonly writeStdout?: (message: string) => void
  readonly runDaemonEntry?: () => Promise<DaemonHandle>
  readonly loadConfig?: () => Promise<Partial<TianjiConfig>>
  readonly confirmOverwrite?: (message: string) => Promise<boolean>
  readonly saveConfig?: (config: Partial<TianjiConfig>) => Promise<void>
}

/** CLI 选项值的允许类型。 */
export type OptionValue = string | number | boolean

export interface ArgumentDefinition {
  readonly name: string
  readonly description: MessageKey
  readonly required: boolean
}

export interface OptionDefinition {
  readonly long: `--${string}`
  readonly short?: `-${string}`
  readonly description: MessageKey
  readonly type: 'string' | 'number' | 'boolean'
  readonly default?: OptionValue
}

export interface CommandContext {
  readonly args: Record<string, string>
  readonly options: Record<string, OptionValue>
  readonly i18n: I18n
  readonly deps: CliDependencies | undefined
}

export type CommandHandler = (context: CommandContext) => Promise<number | undefined>

export interface CommandDefinition {
  readonly name: string
  readonly description: MessageKey
  readonly args?: readonly ArgumentDefinition[]
  readonly options?: readonly OptionDefinition[]
  readonly subcommands?: readonly CommandDefinition[]
  readonly handler: CommandHandler
}

export interface ParsedCommandResult {
  readonly command: CommandDefinition
  readonly context: CommandContext
}
