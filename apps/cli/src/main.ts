import { appendFile, mkdir } from 'node:fs/promises'
import { type AgentSession, type LoadedAgentContext, createAgentSession } from '@tianji/agent'
import type { RunId, RuntimeEvent } from '@tianji/shared'

import { type UserConfigPaths, getUserConfigPaths, loadUserConfigContext } from './config.js'
import { loadDevelopmentEnv } from './dev-env.js'
import { type FollowCliLogOptions, followCliLog } from './log-follow.js'
import type { CliLogEntry, CliLogScope, CliLogger } from './logger.js'
import { createCliLogger } from './logger.js'

const CLI_USAGE = ['Usage:', '  tianji run "<prompt>"', '  tianji log -f'].join('\n')
const CLI_RUN_SCOPE = ['cli', 'run'] as const satisfies CliLogScope
const CLI_RUN_CONFIG_SCOPE = ['cli', 'run', 'config'] as const satisfies CliLogScope
const CLI_RUN_RUNTIME_SCOPE = ['cli', 'run', 'runtime'] as const satisfies CliLogScope
const CLI_RUN_EVENT_SCOPE = ['cli', 'run', 'event'] as const satisfies CliLogScope
const CLI_LOG_FOLLOW_SCOPE = ['cli', 'log', 'follow'] as const satisfies CliLogScope
const CLI_MAIN_SCOPE = ['cli', 'main'] as const satisfies CliLogScope

export interface RunCommand {
  readonly kind: 'run'
  readonly prompt: string
}

export interface LogFollowCommand {
  readonly kind: 'log-follow'
}

export type TianjiCliCommand = RunCommand | LogFollowCommand

export interface RunCommandDependencies {
  readonly loadContext?: () => Promise<LoadedAgentContext>
  readonly createSession?: (context: LoadedAgentContext) => AgentSession
  readonly getUserConfigPaths?: () => UserConfigPaths
  readonly followCliLog?: (logFilePath: string, options?: FollowCliLogOptions) => Promise<void>
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
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
 * @param deps - Optional dependency overrides for testing
 * @returns The final process exit code
 */
export async function runCli(
  argv: readonly string[],
  deps?: RunCommandDependencies
): Promise<number> {
  try {
    loadDevelopmentEnv()
    const command = parseCliArgs(argv)

    if (command.kind === 'run') {
      return await handleRunCommand(command, deps)
    }

    return await handleLogFollowCommand(command, deps)
  } catch (error) {
    await tryLogCliFailure(error, argv)
    console.error(formatCliError(error))
    return error instanceof CliUsageError ? 2 : 1
  }
}

/**
 * 运行一次完整的 LLM 对话轮次，流式输出 assistant 响应文本。
 *
 * @param session - agent 封装后的会话对象
 * @param prompt - 用户输入的 prompt 文本
 * @param logger - CLI 日志记录器
 * @returns 最终退出码
 */
async function executeRunTurn(
  session: AgentSession,
  prompt: string,
  logger: CliLogger
): Promise<number> {
  await logger.logInfo(CLI_RUN_RUNTIME_SCOPE, 'Run started', {
    sessionId: String(session.sessionId),
  })

  let currentRunId: RunId | undefined

  for await (const event of session.chat(prompt)) {
    currentRunId = event.runId
    await handleRuntimeEvent(event, logger)
  }

  process.stdout.write('\n')
  await logger.logInfo(CLI_RUN_SCOPE, 'Run command completed', {
    runId: currentRunId === undefined ? undefined : String(currentRunId),
    sessionId: String(session.sessionId),
  })

  return 0
}

async function handleRuntimeEvent(event: RuntimeEvent, logger: CliLogger): Promise<void> {
  switch (event.type) {
    case 'message.delta':
      await logger.logDebug(CLI_RUN_EVENT_SCOPE, 'Received runtime event', {
        eventType: event.type,
        runId: String(event.runId),
        messageId: event.messageId,
        sequence: event.sequence,
        channel: event.channel,
        delta: event.channel === 'text' ? event.payload.content : undefined,
        deltaLength: event.channel === 'text' ? event.payload.content.length : undefined,
      })
      if (event.channel === 'text') {
        process.stdout.write(event.payload.content)
      }
      break
    case 'run.failed':
      await logger.logError(CLI_RUN_EVENT_SCOPE, 'Received runtime failure event', {
        eventType: event.type,
        sessionId: String(event.sessionId),
        runId: String(event.runId),
        errorCode: event.error.code,
        errorMessage: event.error.message,
      })
      throw new Error(`Run failed: ${event.error.message}`)
    case 'run.completed':
      await logger.logInfo(CLI_RUN_EVENT_SCOPE, 'Received runtime completion event', {
        eventType: event.type,
        sessionId: String(event.sessionId),
        runId: String(event.runId),
      })
      break
  }
}

export async function handleRunCommand(
  command: RunCommand,
  deps?: RunCommandDependencies
): Promise<number> {
  const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
  const paths = resolveUserConfigPaths()
  const logger = createCliLoggerFromPaths(paths)

  await logger.logInfo(CLI_RUN_SCOPE, 'Received run command', {
    promptLength: command.prompt.length,
  })

  const loadContext = deps?.loadContext ?? loadUserConfigContext
  const createSession = deps?.createSession ?? createAgentSession
  await logger.logInfo(CLI_RUN_CONFIG_SCOPE, 'Loading user config context')
  const context = await loadContext()
  await logger.logInfo(CLI_RUN_CONFIG_SCOPE, 'Loaded user config context', {
    configPath: context.paths.configFilePath,
    agentName: context.agent.agentName,
    provider: context.agent.provider,
    modelName: context.agent.modelName,
    soulPath: context.agent.soulPath,
    resolvedEnvVars: context.resolvedEnvVars,
  })

  await logger.logInfo(CLI_RUN_RUNTIME_SCOPE, 'Creating session runtime', {
    agentName: context.agent.agentName,
    provider: context.agent.provider,
    modelName: context.agent.modelName,
  })
  await logger.logInfo(CLI_RUN_RUNTIME_SCOPE, 'Session runtime created', {
    agentName: context.agent.agentName,
    provider: context.agent.provider,
    modelName: context.agent.modelName,
  })

  const session = createSession(context)
  await logger.logInfo(CLI_RUN_RUNTIME_SCOPE, 'Session created', {
    sessionId: String(session.sessionId),
  })

  await logger.logInfo(CLI_RUN_RUNTIME_SCOPE, 'Starting run turn', {
    sessionId: String(session.sessionId),
    promptLength: command.prompt.length,
  })

  return executeRunTurn(session, command.prompt, logger)
}

async function handleLogFollowCommand(
  _command: LogFollowCommand,
  deps?: RunCommandDependencies
): Promise<number> {
  const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
  const followCliLogCommand = deps?.followCliLog ?? followCliLog
  const paths = resolveUserConfigPaths()

  await followCliLogCommand(paths.cliLogFilePath)
  return 0
}

async function tryLogCliFailure(error: unknown, argv: readonly string[]): Promise<void> {
  try {
    const paths = getUserConfigPaths()
    const logger = createCliLoggerFromPaths(paths)
    await logger.logError(CLI_MAIN_SCOPE, 'CLI command failed', {
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

function createCliLoggerFromPaths(paths: UserConfigPaths): CliLogger {
  return createCliLogger({
    sink: {
      write(entry: CliLogEntry) {
        return appendCliLogEntry(paths, entry)
      },
    },
  })
}

async function appendCliLogEntry(paths: UserConfigPaths, entry: CliLogEntry): Promise<void> {
  await mkdir(paths.logsDir, { recursive: true })
  await appendFile(paths.cliLogFilePath, `${JSON.stringify(entry)}\n`, 'utf8')
}
