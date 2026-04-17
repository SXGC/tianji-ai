import { appendFile, mkdir } from 'node:fs/promises'

import { buildDefaultGraph, createAgentSession, createUnifiedRuntimeEntry } from '@tianji/agent'
import type { DomainEvent, RunId } from '@tianji/shared'

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

    const createEntry = deps?.createUnifiedEntry ?? createDefaultUnifiedEntry

    await logger.logInfo(CLI_RUN_RUNTIME_SCOPE, 'Creating unified runtime entry', {
      agentName: context.agent.agentName,
      provider: context.agent.provider,
      modelName: context.agent.modelName,
      promptLength: prompt.length,
    })

    const entry = await createEntry(context)
    return await executeRunTurn(entry, prompt, logger)
  },
}

async function executeRunTurn(
  entry: Awaited<ReturnType<typeof createDefaultUnifiedEntry>>,
  prompt: string,
  logger: CliLogger
): Promise<number> {
  let currentRunId: RunId | undefined
  let currentSessionId: string | undefined

  const handle = await entry.run({
    source: 'cli',
    agentId: 'default',
    input: prompt,
  })

  for await (const event of handle.events) {
    if ('runId' in event && event.runId !== undefined) {
      currentRunId = event.runId
    }
    if ('sessionId' in event && event.sessionId !== undefined) {
      currentSessionId = String(event.sessionId)
    }
    await handleRuntimeEvent(event, logger)
  }

  process.stdout.write('\n')
  await logger.logInfo(CLI_RUN_SCOPE, 'Run command completed', {
    runId: currentRunId === undefined ? undefined : String(currentRunId),
    sessionId: currentSessionId,
  })

  return 0
}

async function handleRuntimeEvent(event: DomainEvent, logger: CliLogger): Promise<void> {
  switch (event.type) {
    case 'MessageDelta':
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
    case 'RunFailed':
      await logger.logError(CLI_RUN_EVENT_SCOPE, 'Received runtime failure event', {
        eventType: event.type,
        sessionId: String(event.sessionId),
        runId: String(event.runId),
        errorCode: event.error.code,
        errorMessage: event.error.message,
      })
      throw new Error(`Run failed: ${event.error.message}`)
    case 'RunCompleted':
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

async function createDefaultUnifiedEntry(
  context: Awaited<ReturnType<typeof loadUserConfigContext>>
) {
  const built = await buildDefaultGraph(
    { source: 'cli', input: '', agentId: context.agent.agentName },
    context
  )

  return createUnifiedRuntimeEntry({
    loadDefaultGraph: async () => built.graph,
    createExecutorRegistry: async () => built.executorFactory,
    runtime: {
      runGraph: async ({ request, graph, executors }) => {
        const session = await createAgentSession(context)
        return {
          sessionId: session.sessionId,
          runId: undefined,
          events: session.queryWithGraph(graph, {
            initialState: { input: request.input },
            compileOptions: { agentExecutorFactory: executors },
          }),
        }
      },
      resumeGraph: async () => {
        throw new Error('CLI unified entry resume is not implemented yet')
      },
      cancelRun: async () => undefined,
      streamRun: () => {
        throw new Error('CLI unified entry stream is not implemented yet')
      },
    },
  })
}
