import { fork } from 'node:child_process'
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import {
  type AgentSession,
  DaemonClient,
  type LoadedAgentContext,
  type PingResponse,
  createAgentSession,
} from '@tianji/agent'
import type { RunId, RuntimeEvent } from '@tianji/shared'

import { type UserConfigPaths, getUserConfigPaths, loadUserConfigContext } from './config.js'
import { runDaemonEntry } from './daemon-entry.js'
import { loadDevelopmentEnv } from './dev-env.js'
import { type FollowCliLogOptions, followCliLog } from './log-follow.js'
import type { CliLogEntry, CliLogScope, CliLogger } from './logger.js'
import { createCliLogger } from './logger.js'

const DEFAULT_LOG_LINES = 100
const CLI_HELP_TEXT = [
  'Usage:',
  '  tianji run "<prompt>"',
  '    Run one prompt through the configured agent',
  '  tianji log -f [--lines <n>]',
  '    Follow the CLI log and replay the latest lines first',
  '  tianji daemon [--fg]',
  '    Start the background daemon',
  '  tianji chat',
  '    Connect to daemon for multi-turn chat',
  '  tianji status',
  '    Check daemon status',
  '  tianji stop',
  '    Stop the daemon',
  '  tianji help',
  '    Print all available commands and descriptions',
].join('\n')
const CLI_RUN_SCOPE = ['cli', 'run'] as const satisfies CliLogScope
const CLI_RUN_CONFIG_SCOPE = ['cli', 'run', 'config'] as const satisfies CliLogScope
const CLI_RUN_RUNTIME_SCOPE = ['cli', 'run', 'runtime'] as const satisfies CliLogScope
const CLI_RUN_EVENT_SCOPE = ['cli', 'run', 'event'] as const satisfies CliLogScope
const CLI_LOG_FOLLOW_SCOPE = ['cli', 'log', 'follow'] as const satisfies CliLogScope
const CLI_HELP_SCOPE = ['cli', 'help'] as const satisfies CliLogScope
const CLI_MAIN_SCOPE = ['cli', 'main'] as const satisfies CliLogScope

export interface RunCommand {
  readonly kind: 'run'
  readonly prompt: string
}

export interface LogFollowCommand {
  readonly kind: 'log-follow'
  readonly lines: number
}

export interface HelpCommand {
  readonly kind: 'help'
}

export interface DaemonCommand {
  readonly kind: 'daemon'
  readonly foreground: boolean
}

export interface ChatCommand {
  readonly kind: 'chat'
}

export interface StatusCommand {
  readonly kind: 'status'
}

export interface StopCommand {
  readonly kind: 'stop'
}

export type TianjiCliCommand =
  | RunCommand
  | LogFollowCommand
  | HelpCommand
  | DaemonCommand
  | ChatCommand
  | StatusCommand
  | StopCommand

export interface RunCommandDependencies {
  readonly loadContext?: () => Promise<LoadedAgentContext>
  readonly createSession?: (context: LoadedAgentContext) => AgentSession
  readonly getUserConfigPaths?: () => UserConfigPaths
  readonly followCliLog?: (logFilePath: string, options?: FollowCliLogOptions) => Promise<void>
  readonly writeStdout?: (message: string) => void
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
    throw new CliUsageError(`Missing command.\n\n${CLI_HELP_TEXT}`)
  }

  if (commandName === 'run') {
    if (restArgs.length !== 1) {
      throw new CliUsageError(
        `Command "run" requires exactly one prompt argument.\n\n${CLI_HELP_TEXT}`
      )
    }

    return {
      kind: 'run',
      prompt: restArgs[0],
    }
  }

  if (commandName === 'help') {
    if (restArgs.length > 0) {
      throw new CliUsageError(`Command "help" does not accept arguments.\n\n${CLI_HELP_TEXT}`)
    }

    return {
      kind: 'help',
    }
  }

  if (commandName === 'log') {
    return parseLogCommandArgs(restArgs)
  }

  if (commandName === 'daemon') {
    if (restArgs.length === 0) {
      return { kind: 'daemon', foreground: false }
    }
    if (restArgs.length === 1 && restArgs[0] === '--fg') {
      return { kind: 'daemon', foreground: true }
    }
    throw new CliUsageError(`Command 'daemon' only supports '--fg'.`)
  }

  if (commandName === 'chat') {
    if (restArgs.length > 0) {
      throw new CliUsageError(`Command "chat" does not accept arguments.\n\n${CLI_HELP_TEXT}`)
    }
    return { kind: 'chat' }
  }

  if (commandName === 'status') {
    if (restArgs.length > 0) {
      throw new CliUsageError(`Command "status" does not accept arguments.\n\n${CLI_HELP_TEXT}`)
    }
    return { kind: 'status' }
  }

  if (commandName === 'stop') {
    if (restArgs.length > 0) {
      throw new CliUsageError(`Command "stop" does not accept arguments.\n\n${CLI_HELP_TEXT}`)
    }
    return { kind: 'stop' }
  }

  throw new CliUsageError(`Unknown command "${commandName}".\n\n${CLI_HELP_TEXT}`)
}

/**
 * 解析 `log` 子命令参数。
 *
 * @param args - `log` 后续参数
 * @returns 结构化的 log follow 命令
 */
function parseLogCommandArgs(args: readonly string[]): LogFollowCommand {
  const [followFlag, ...optionArgs] = args

  if (followFlag !== '-f' && followFlag !== '--follow') {
    throw new CliUsageError(`Command "log" only supports "-f" or "--follow".\n\n${CLI_HELP_TEXT}`)
  }

  if (optionArgs.length === 0) {
    return {
      kind: 'log-follow',
      lines: DEFAULT_LOG_LINES,
    }
  }

  if (optionArgs.length !== 2 || (optionArgs[0] !== '--lines' && optionArgs[0] !== '-n')) {
    throw new CliUsageError(
      `Command "log" only supports "--lines <n>" or "-n <n>" after follow.\n\n${CLI_HELP_TEXT}`
    )
  }

  const lines = Number.parseInt(optionArgs[1], 10)
  if (!Number.isInteger(lines) || lines <= 0) {
    throw new CliUsageError(
      `Command "log" requires a positive integer for lines.\n\n${CLI_HELP_TEXT}`
    )
  }

  return {
    kind: 'log-follow',
    lines,
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
    const command = parseCliArgs(argv)

    if (command.kind === 'run') {
      return await handleRunCommand(command, deps)
    }

    if (command.kind === 'help') {
      return handleHelpCommand(deps)
    }

    if (command.kind === 'daemon') {
      return handleDaemonCommand(command, deps)
    }

    if (command.kind === 'chat') {
      return handleChatCommand(deps)
    }

    if (command.kind === 'status') {
      return handleStatusCommand(deps)
    }

    if (command.kind === 'stop') {
      return handleStopCommand(deps)
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
  command: LogFollowCommand,
  deps?: RunCommandDependencies
): Promise<number> {
  const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
  const followCliLogCommand = deps?.followCliLog ?? followCliLog
  const paths = resolveUserConfigPaths()

  await followCliLogCommand(paths.cliLogFilePath, {
    lines: command.lines,
  })
  return 0
}

/**
 * 输出 CLI 帮助文本。
 *
 * @param deps - 可选依赖覆盖，便于测试 stdout
 * @returns 成功退出码
 */
function handleHelpCommand(deps?: RunCommandDependencies): number {
  const writeStdout = deps?.writeStdout ?? process.stdout.write.bind(process.stdout)
  writeStdout(`${CLI_HELP_TEXT}\n`)
  return 0
}

async function readDaemonPort(paths: UserConfigPaths): Promise<number | undefined> {
  try {
    const content = await readFile(paths.daemonPortPath, 'utf8')
    const port = Number.parseInt(content.trim(), 10)
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

async function readDaemonPid(paths: UserConfigPaths): Promise<number | undefined> {
  try {
    const content = await readFile(paths.daemonPidPath, 'utf8')
    const pid = Number.parseInt(content.trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

async function tryCreateDaemonClient(paths: UserConfigPaths): Promise<DaemonClient | undefined> {
  const port = await readDaemonPort(paths)
  if (port === undefined) {
    return undefined
  }
  return new DaemonClient({ host: '127.0.0.1', port })
}

async function requireDaemonClient(deps?: RunCommandDependencies): Promise<DaemonClient> {
  const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
  const paths = resolveUserConfigPaths()
  const client = await tryCreateDaemonClient(paths)
  if (client === undefined) {
    throw new CliUsageError('No daemon running. Start with: tianji daemon')
  }
  return client
}

async function cleanupStaleDaemonFiles(paths: UserConfigPaths): Promise<void> {
  await rm(paths.daemonPortPath, { force: true })
  await rm(paths.daemonPidPath, { force: true })
}

async function waitForDaemonReady(
  paths: UserConfigPaths,
  timeoutMs = 10000
): Promise<{ pid: number; port: number }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const port = await readDaemonPort(paths)
    if (port !== undefined) {
      const client = new DaemonClient({ host: '127.0.0.1', port })
      try {
        await client.ping()
        const pid = await readDaemonPid(paths)
        return { pid: pid ?? 0, port }
      } catch {
        // Daemon not accepting connections yet
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for daemon to become ready')
}

async function handleDaemonCommand(
  command: DaemonCommand,
  deps?: RunCommandDependencies
): Promise<number> {
  const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
  const paths = resolveUserConfigPaths()

  const existingClient = await tryCreateDaemonClient(paths)
  if (existingClient !== undefined) {
    try {
      const ping = await existingClient.ping()
      process.stdout.write(`Daemon already running (pid=${ping.pid})\n`)
      return 0
    } catch {
      await cleanupStaleDaemonFiles(paths)
    }
  }

  if (command.foreground) {
    await runDaemonEntry()
    return 0
  }

  const child = fork(new URL('./daemon-entry.js', import.meta.url), [], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  const { pid, port } = await waitForDaemonReady(paths)
  process.stdout.write(`Daemon started (pid=${pid}, port=${port})\n`)
  return 0
}

async function handleChatCommand(deps?: RunCommandDependencies): Promise<number> {
  const client = await requireDaemonClient(deps)
  const ping = await client.ping()
  process.stdout.write(`Connected to daemon (pid=${ping.pid})\n`)

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  })
  rl.prompt()

  const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
  const paths = resolveUserConfigPaths()
  const logger = createCliLoggerFromPaths(paths)

  for await (const line of rl) {
    const trimmed = line.trim()
    if (trimmed === '') {
      rl.prompt()
      continue
    }
    if (trimmed === '.exit') {
      rl.close()
      break
    }

    for await (const event of client.sendChat(trimmed)) {
      await handleRuntimeEvent(event, logger)
    }
    process.stdout.write('\n')
    rl.prompt()
  }

  return 0
}

async function handleStatusCommand(deps?: RunCommandDependencies): Promise<number> {
  try {
    const client = await requireDaemonClient(deps)
    const ping = await client.ping()
    const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
    const paths = resolveUserConfigPaths()
    const port = await readDaemonPort(paths)
    process.stdout.write(
      `Daemon running (pid=${ping.pid}, port=${port}, sessionId=${ping.sessionId}, uptime=${ping.uptime}s)\n`
    )
    return 0
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n`)
      return 1
    }
    throw error
  }
}

async function handleStopCommand(deps?: RunCommandDependencies): Promise<number> {
  try {
    const client = await requireDaemonClient(deps)
    await client.shutdown()
    process.stdout.write('Daemon stopped\n')
    return 0
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n`)
      return 1
    }
    throw error
  }
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
