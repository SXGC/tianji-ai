import type { AppMessage, RuntimeEvent, SessionId } from '@tianji/contracts'
import { type SessionRuntime, createSessionRuntime } from '@tianji/runtime'

import type { LoadedUserConfigContext } from './config.js'
import {
  type UserConfigPaths,
  getUserConfigPaths,
  injectProviderEnv,
  loadUserConfigContext,
} from './config.js'
import { loadDevelopmentEnv } from './dev-env.js'
import { type FollowCliLogOptions, followCliLog } from './log-follow.js'
import type { CliLogScope, CliLogger } from './logger.js'
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
  readonly loadContext?: () => Promise<LoadedUserConfigContext>
  readonly createRuntime?: (context: LoadedUserConfigContext) => SessionRuntime
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
 * 根据用户配置上下文创建 deepagents session runtime。
 *
 * @param context - 已加载的用户配置上下文
 * @returns 已初始化的 SessionRuntime 实例
 */
export function createCliRuntime(context: LoadedUserConfigContext): SessionRuntime {
  const providerBaseUrl = readProviderBaseUrl(context.agent.providerConfig)
  const providerHeaders = readProviderHeaders(context.agent.providerConfig)

  return createSessionRuntime({
    deepagents: {
      model: createCliModel(context),
      providerConfig: {
        provider: context.agent.provider,
        model: context.agent.modelName,
        apiKey: context.agent.providerConfig?.apiKey,
        baseUrl: providerBaseUrl,
        headers: providerHeaders,
      },
    },
    snapshotStore: context.snapshotStore,
  })
}

function readProviderBaseUrl(
  providerConfig: LoadedUserConfigContext['agent']['providerConfig']
): string | undefined {
  return typeof providerConfig?.baseUrl === 'string' ? providerConfig.baseUrl : undefined
}

function readProviderHeaders(
  providerConfig: LoadedUserConfigContext['agent']['providerConfig']
): Record<string, string> | undefined {
  if (
    providerConfig?.headers === undefined ||
    providerConfig.headers === null ||
    typeof providerConfig.headers !== 'object'
  ) {
    return undefined
  }

  const headerEntries = Object.entries(providerConfig.headers).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )

  return headerEntries.length > 0 ? Object.fromEntries(headerEntries) : undefined
}

/**
 * 为 CLI 构造 deepagents 可消费的模型标识。
 *
 * @param context - 已加载的用户配置上下文
 * @returns `provider:modelName` 形式的模型标识
 */
function createCliModel(context: LoadedUserConfigContext): string {
  return `${context.agent.provider}:${context.agent.modelName}`
}

/**
 * 运行一次完整的 LLM 对话轮次，流式输出 assistant 响应文本。
 *
 * @param runtime - 已创建的 session runtime
 * @param sessionId - 目标 session ID
 * @param prompt - 用户输入的 prompt 文本
 * @param systemPrompt - 从 SOUL.md 加载的 system prompt
 * @param logger - CLI 日志记录器
 * @returns 最终退出码
 */
async function executeRunTurn(
  runtime: SessionRuntime,
  sessionId: SessionId,
  prompt: string,
  systemPrompt: string | undefined,
  logger: CliLogger
): Promise<number> {
  const userMessage: AppMessage = {
    id: `msg_user_${Date.now()}`,
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    createdAt: Date.now(),
  }

  const runId = await runtime.runTurn({
    sessionId,
    message: userMessage,
    systemPrompt,
  })

  await logger.logInfo(CLI_RUN_RUNTIME_SCOPE, 'Run started', {
    runId: String(runId),
    sessionId: String(sessionId),
  })

  for await (const event of runtime.streamEvents(runId)) {
    await handleRuntimeEvent(event, logger)
  }

  process.stdout.write('\n')
  await logger.logInfo(CLI_RUN_SCOPE, 'Run command completed', {
    runId: String(runId),
    sessionId: String(sessionId),
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
  const logger = createCliLogger(paths)

  await logger.logInfo(CLI_RUN_SCOPE, 'Received run command', {
    promptLength: command.prompt.length,
  })

  const loadContext = deps?.loadContext ?? loadUserConfigContext
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

  injectProviderEnv(context)
  await logger.logInfo(CLI_RUN_CONFIG_SCOPE, 'Injected provider env vars', {
    provider: context.agent.provider,
  })

  const createRuntime = deps?.createRuntime ?? createCliRuntime
  await logger.logInfo(CLI_RUN_RUNTIME_SCOPE, 'Creating session runtime', {
    agentName: context.agent.agentName,
    provider: context.agent.provider,
    modelName: context.agent.modelName,
  })
  const runtime = createRuntime(context)
  await logger.logInfo(CLI_RUN_RUNTIME_SCOPE, 'Session runtime created', {
    agentName: context.agent.agentName,
    provider: context.agent.provider,
    modelName: context.agent.modelName,
  })

  const sessionSnapshot = await runtime.createSession()
  await logger.logInfo(CLI_RUN_RUNTIME_SCOPE, 'Session created', {
    sessionId: String(sessionSnapshot.sessionId),
  })

  await logger.logInfo(CLI_RUN_RUNTIME_SCOPE, 'Starting run turn', {
    sessionId: String(sessionSnapshot.sessionId),
    promptLength: command.prompt.length,
  })

  return executeRunTurn(
    runtime,
    sessionSnapshot.sessionId,
    command.prompt,
    context.agent.soul,
    logger
  )
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
    const logger = createCliLogger(getUserConfigPaths())
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
