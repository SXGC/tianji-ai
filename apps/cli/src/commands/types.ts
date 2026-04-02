import type { AgentSession, LoadedAgentContext } from '@tianji/agent'
import type { TianjiConfig } from '@tianji/shared'

import type { UserConfigPaths } from '../config.js'
import type { I18n, MessageKey } from '../i18n/index.js'
import type { FollowCliLogOptions } from '../log-follow.js'

/**
 * 所有 CLI 命令共用的可注入依赖。
 */
export interface CliDependencies {
  readonly loadContext?: () => Promise<LoadedAgentContext>
  readonly createSession?: (context: LoadedAgentContext) => AgentSession
  readonly getUserConfigPaths?: () => UserConfigPaths
  readonly followCliLog?: (
    logFilePath: string,
    i18n: I18n,
    options?: FollowCliLogOptions
  ) => Promise<void>
  readonly writeStdout?: (message: string) => void
  readonly runDaemonEntry?: () => Promise<void>
  readonly loadConfig?: () => Promise<Partial<TianjiConfig>>
}

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
  readonly default?: string | number | boolean
}

export interface CommandContext {
  readonly args: Record<string, string>
  readonly options: Record<string, string | number | boolean>
  readonly i18n: I18n
  readonly deps: CliDependencies | undefined
}

export type CommandHandler = (context: CommandContext) => Promise<number>

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
