import { ChatOpenAI } from '@langchain/openai'
import type { AppMessage, RuntimeEvent, SessionId } from '@tianji/contracts'
import { type SessionRuntime, createSessionRuntime } from '@tianji/runtime'

import type { LoadedUserConfigContext } from './config.js'
import { getUserConfigPaths, injectProviderEnv, loadUserConfigContext } from './config.js'
import { followCliLog } from './log-follow.js'
import type { CliLogger } from './logger.js'
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

export interface RunCommandDependencies {
  readonly loadContext?: () => Promise<LoadedUserConfigContext>
  readonly createRuntime?: (context: LoadedUserConfigContext) => SessionRuntime
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
    const command = parseCliArgs(argv)

    if (command.kind === 'run') {
      return await handleRunCommand(command, deps)
    }

    return await handleLogFollowCommand(command)
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
  const model = createCliModel(context)

  return createSessionRuntime({
    deepagents: { model },
  })
}

/**
 * 为 CLI 构造 deepagents 可消费的模型实例。
 *
 * openai provider 需要显式透传 baseUrl，否则 deepagents 仅根据字符串模型名
 * 走默认 OpenAI 端点，无法命中用户配置的兼容网关。
 *
 * @param context - 已加载的用户配置上下文
 * @returns deepagents 可直接使用的模型实例或模型标识
 */
function createCliModel(context: LoadedUserConfigContext): string | ChatOpenAI {
  if (context.agent.provider !== 'openai') {
    return `${context.agent.provider}:${context.agent.modelName}`
  }

  const baseUrl =
    typeof context.agent.providerConfig?.baseUrl === 'string'
      ? context.agent.providerConfig.baseUrl
      : undefined

  return new ChatOpenAI({
    model: context.agent.modelName,
    apiKey: context.agent.providerConfig?.apiKey,
    configuration:
      baseUrl === undefined
        ? undefined
        : {
            baseURL: baseUrl,
          },
  })
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

  await logger.logInfo('cli.run.runtime', 'Run started', { runId: String(runId) })

  for await (const event of runtime.streamEvents(runId)) {
    await handleRuntimeEvent(event, logger)
  }

  process.stdout.write('\n')
  await logger.logInfo('cli.run.event', 'Run completed', { runId: String(runId) })

  return 0
}

async function handleRuntimeEvent(event: RuntimeEvent, logger: CliLogger): Promise<void> {
  switch (event.type) {
    case 'message.delta':
      if (event.channel === 'text') {
        process.stdout.write(event.payload.content)
      }
      break
    case 'run.failed':
      await logger.logError('cli.run.event', 'Run failed', {
        errorCode: event.error.code,
        errorMessage: event.error.message,
      })
      throw new Error(`Run failed: ${event.error.message}`)
    case 'run.completed':
      break
  }
}

export async function handleRunCommand(
  command: RunCommand,
  deps?: RunCommandDependencies
): Promise<number> {
  const paths = getUserConfigPaths()
  const logger = createCliLogger(paths)

  await logger.logInfo('cli.run', 'Received run command', {
    promptLength: command.prompt.length,
  })

  const loadContext = deps?.loadContext ?? loadUserConfigContext
  const context = await loadContext()
  await logger.logInfo('cli.run.config', 'Loaded user config context', {
    configPath: context.paths.configFilePath,
    agentName: context.agent.agentName,
    provider: context.agent.provider,
    modelName: context.agent.modelName,
    soulPath: context.agent.soulPath,
    resolvedEnvVars: context.resolvedEnvVars,
  })

  injectProviderEnv(context)
  await logger.logInfo('cli.run.config', 'Provider env vars injected', {
    provider: context.agent.provider,
  })

  const createRuntime = deps?.createRuntime ?? createCliRuntime
  const runtime = createRuntime(context)
  await logger.logInfo('cli.run.runtime', 'Session runtime created', {
    agentName: context.agent.agentName,
    model: `${context.agent.provider}:${context.agent.modelName}`,
  })

  const sessionSnapshot = await runtime.createSession()
  await logger.logInfo('cli.run.runtime', 'Session created', {
    sessionId: String(sessionSnapshot.sessionId),
  })

  return executeRunTurn(
    runtime,
    sessionSnapshot.sessionId,
    command.prompt,
    context.agent.soul,
    logger
  )
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
