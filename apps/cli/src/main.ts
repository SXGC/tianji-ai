import type { LoadedUserConfigContext } from './config.js'
import { getUserConfigPaths, loadUserConfigContext } from './config.js'
import { followCliLog } from './log-follow.js'
import { createCliLogger } from './logger.js'

const CLI_USAGE = ['Usage:', '  tianji run "<prompt>"', '  tianji log -f'].join('\n')

export interface RunCommand {
  readonly kind: 'run'
  readonly prompt: string
}

export interface LogFollowCommand {
  readonly kind: 'log-follow'
}

export type TianjiCliCommand = RunCommand | LogFollowCommand

class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

interface PreparedCliRuntimeInput {
  readonly deepagentsModel: string
  readonly agentName: string
  readonly provider: string
  readonly modelName: string
  readonly soulPath: string
}

/**
 * Parses raw CLI argv into the stage-2 command union.
 *
 * @param argv - Raw argv items without the node executable and script path
 * @returns The parsed CLI command
 */
export function parseCliArgs(argv: readonly string[]): TianjiCliCommand {
  const [commandName, ...restArgs] = argv

  if (commandName === undefined) {
    throw new CliUsageError(`Missing command.\n\n${CLI_USAGE}`)
  }

  if (commandName === 'run') {
    if (restArgs.length !== 1) {
      throw new CliUsageError(`Command "run" requires exactly one prompt argument.\n\n${CLI_USAGE}`)
    }

    return {
      kind: 'run',
      prompt: restArgs[0],
    }
  }

  if (commandName === 'log') {
    if (restArgs.length !== 1 || (restArgs[0] !== '-f' && restArgs[0] !== '--follow')) {
      throw new CliUsageError(`Command "log" only supports "-f" or "--follow".\n\n${CLI_USAGE}`)
    }

    return {
      kind: 'log-follow',
    }
  }

  throw new CliUsageError(`Unknown command "${commandName}".\n\n${CLI_USAGE}`)
}

/**
 * Runs the Tianji CLI main dispatch flow and returns the process exit code.
 *
 * @param argv - Raw argv items without the executable and script path
 * @returns The final process exit code
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    const command = parseCliArgs(argv)

    if (command.kind === 'run') {
      return await handleRunCommand(command)
    }

    return await handleLogFollowCommand(command)
  } catch (error) {
    await tryLogCliFailure(error, argv)
    console.error(formatCliError(error))
    return error instanceof CliUsageError ? 2 : 1
  }
}

async function handleRunCommand(command: RunCommand): Promise<number> {
  const paths = getUserConfigPaths()
  const logger = createCliLogger(paths)

  await logger.logInfo('cli.run', 'Received run command', {
    promptLength: command.prompt.length,
  })

  const context = await loadUserConfigContext()
  await logger.logInfo('cli.config', 'Loaded user config context', {
    configPath: context.paths.configFilePath,
    agentName: context.agent.agentName,
    provider: context.agent.provider,
    modelName: context.agent.modelName,
    soulPath: context.agent.soulPath,
    resolvedEnvVars: context.resolvedEnvVars,
  })

  const runtimeInput = createCliRuntime(context)
  await logger.logInfo('cli.runtime', 'Prepared runtime placeholder input', {
    ...runtimeInput,
  })
  await logger.logWarn('cli.run', 'Runtime execution is not implemented in stage 2', {
    promptLength: command.prompt.length,
  })

  console.error('`tianji run` 已进入 CLI 主流程，但真实 runtime 执行会在后续阶段实现。')
  return 1
}

async function handleLogFollowCommand(_command: LogFollowCommand): Promise<number> {
  const paths = getUserConfigPaths()
  const logger = createCliLogger(paths)

  await logger.logInfo('cli.log', 'Starting CLI log follow loop', {
    logFilePath: paths.cliLogFilePath,
  })

  await followCliLog(paths.cliLogFilePath)
  return 0
}

/**
 * Prepares the runtime input boundary for later deepagents execution stages.
 *
 * @param context - The loaded user config context
 * @returns The minimal runtime input prepared for later execution wiring
 */
function createCliRuntime(context: LoadedUserConfigContext): PreparedCliRuntimeInput {
  return {
    deepagentsModel: `${context.agent.provider}:${context.agent.modelName}`,
    agentName: context.agent.agentName,
    provider: context.agent.provider,
    modelName: context.agent.modelName,
    soulPath: context.agent.soulPath,
  }
}

async function tryLogCliFailure(error: unknown, argv: readonly string[]): Promise<void> {
  try {
    const logger = createCliLogger(getUserConfigPaths())
    await logger.logError('cli.main', 'CLI command failed', {
      argv: [...argv],
      error: getErrorMessage(error),
    })
  } catch {
    // Ignore secondary logging failures so the primary CLI error can surface.
  }
}

function formatCliError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return `Unknown CLI error: ${String(error)}`
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
