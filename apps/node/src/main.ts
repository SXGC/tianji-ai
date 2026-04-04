import packageJson from '../package.json' with { type: 'json' }
import { renderCommandHelp, renderHelp } from './commands/help.js'
import { CliUsageError, extractGlobalFlags, parseCommand } from './commands/parse.js'
import { COMMAND_REGISTRY } from './commands/registry.js'
import type { CliDependencies } from './commands/types.js'
import { type LoadedUserConfigContext, loadUserConfigContext } from './config.js'
import { loadDevelopmentEnv } from './dev-env.js'
import { createI18n, detectLocale } from './i18n/index.js'

export type DaemonSubcommand = 'start' | 'status' | 'stop' | 'restart'

export interface DaemonCommand {
  readonly kind: 'daemon'
  readonly subcommand: DaemonSubcommand
  readonly foreground: boolean
}

export interface ChatCommand {
  readonly kind: 'chat'
}

export interface RunCommand {
  readonly kind: 'run'
  readonly prompt: string
}

export interface RegisterCommand {
  readonly kind: 'register'
  readonly url: string
}

export interface LogFollowCommand {
  readonly kind: 'log-follow'
  readonly lines: number
}

export interface HelpCommand {
  readonly kind: 'help'
}

export type TianjiCliCommand =
  | RunCommand
  | RegisterCommand
  | LogFollowCommand
  | HelpCommand
  | DaemonCommand
  | ChatCommand

export type RunCommandDependencies = CliDependencies

const VERSION = packageJson.version

/**
 * Parses raw CLI argv into the stage-2 command union.
 *
 * @param argv - Raw argv items without the node executable and script path
 * @returns The parsed CLI command
 */
export function parseCliArgs(argv: readonly string[]): TianjiCliCommand {
  const globalFlags = extractGlobalFlags(argv)
  const i18n = createI18n('en')

  if (globalFlags.help) {
    return { kind: 'help' }
  }

  const parsed = parseCommand(globalFlags.remaining, COMMAND_REGISTRY, i18n)
  if (parsed.command.name === 'run') {
    return { kind: 'run', prompt: parsed.context.args.prompt }
  }
  if (parsed.command.name === 'register') {
    return { kind: 'register', url: parsed.context.args.url }
  }
  if (parsed.command.name === 'log') {
    return { kind: 'log-follow', lines: parsed.context.options.lines as number }
  }
  if (parsed.command.name === 'chat') {
    return { kind: 'chat' }
  }

  const foreground = parsed.context.options.fg === true
  return {
    kind: 'daemon',
    subcommand: parsed.command.name as DaemonSubcommand,
    foreground,
  }
}

/**
 * Runs the Tianji CLI main dispatch flow and returns the process exit code.
 *
 * @param argv - Raw argv items without the executable and script path
 * @param deps - Optional dependency overrides for testing
 * @returns The final process exit code
 */
export async function runCli(
  argv: readonly string[],
  deps?: RunCommandDependencies
): Promise<number> {
  try {
    loadDevelopmentEnv()

    const config = deps?.loadConfig
      ? await deps.loadConfig().catch(() => ({}))
      : await loadUserConfigContext()
          .then((context: LoadedUserConfigContext) => context.config)
          .catch(() => ({}))
    const i18n = createI18n(detectLocale(config))

    const globalFlags = extractGlobalFlags(argv)
    if (globalFlags.version) {
      process.stdout.write(`tianji v${VERSION}\n`)
      return 0
    }

    if (globalFlags.help) {
      process.stdout.write(`${renderHelp(COMMAND_REGISTRY, i18n, VERSION)}\n`)
      return 0
    }

    if (globalFlags.commandHelp) {
      const topLevelCommand = COMMAND_REGISTRY.find(
        (command) => command.name === globalFlags.remaining[0]
      )
      if (topLevelCommand === undefined) {
        throw new CliUsageError(
          `${i18n.t('error.unknown_command', { command: globalFlags.remaining[0] ?? '' })} ${i18n.t('error.run_help_hint')}`
        )
      }

      const helpTarget = topLevelCommand
      process.stdout.write(`${renderCommandHelp(helpTarget, i18n)}\n`)
      return 0
    }

    const parsed = parseCommand(globalFlags.remaining, COMMAND_REGISTRY, i18n, deps)

    return await parsed.command.handler(parsed.context)
  } catch (error) {
    console.error(formatCliError(error))
    return error instanceof CliUsageError ? 2 : 1
  }
}

function formatCliError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return `Unknown CLI error: ${String(error)}`
}
