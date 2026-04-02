import { appendFile, mkdir } from 'node:fs/promises'

import { createAgentSession } from '@tianji/agent'
import type { RunId, RuntimeEvent } from '@tianji/shared'

import { type UserConfigPaths, getUserConfigPaths, loadUserConfigContext } from '../config.js'
import type { CliLogEntry, CliLogScope, CliLogger } from '../logger.js'
import { createCliLogger } from '../logger.js'

import type { CommandDefinition } from './types.js'

const CLI_RUN_SCOPE = ['cli', 'run'] as const satisfies CliLogScope
const CLI_RUN_CONFIG_SCOPE = ['cli', 'run', 'config'] as const satisfies CliLogScope
const CLI_RUN_RUNTIME_SCOPE = ['cli', 'run', 'runtime'] as const satisfies CliLogScope
const CLI_RUN_EVENT_SCOPE = ['cli', 'run', 'event'] as const satisfies CliLogScope

/**
 * `run` 命令定义，执行单轮 prompt。
 */
export const runCommand: CommandDefinition = {
  name: 'run',
  description: 'cmd.run.description',
  args: [{ name: 'prompt', description: 'cmd.run.arg.prompt', required: true }],
  handler: async ({ args, deps }) => {
    const prompt = args.prompt
    const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
    const paths = resolveUserConfigPaths()
    const logger = createCliLoggerFromPaths(paths)

    await logger.logInfo(CLI_RUN_SCOPE, 'Received run command', {
      promptLength: prompt.length,
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
      promptLength: prompt.length,
    })

    return executeRunTurn(session, prompt, logger)
  },
}

async function executeRunTurn(
  session: Awaited<ReturnType<typeof createAgentSession>>,
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
