import { LocalShellBackend } from 'deepagents'

import {
  type ObserverLogger,
  type SessionRuntime,
  ToolRegistry,
  createSessionRuntime,
} from '@tianji/runtime'
import type { AppMessage, RunId, RuntimeEvent, SessionId } from '@tianji/shared'

import { type LoadedAgentContext, injectProviderEnv } from './context.js'
import { createFetchUrlTool } from './tools/fetch-url-tool.js'

export interface AgentRuntimeOptions {
  readonly logger?: ObserverLogger
}

export interface ChatOptions {
  readonly systemPrompt?: string
}

export interface AgentSession {
  readonly sessionId: SessionId
  readonly query: (prompt: string, options?: ChatOptions) => AsyncIterable<RuntimeEvent>
  readonly abort: () => void
}

/**
 * Creates a runtime instance from an already loaded agent context.
 *
 * The runtime uses {@link LocalShellBackend} to give the agent real filesystem
 * and shell access in the configured workspace directory.
 *
 * @param context - The resolved agent bootstrap context
 * @returns A session runtime configured for the selected provider and model
 */
export async function createAgentRuntime(
  context: LoadedAgentContext,
  options?: AgentRuntimeOptions
): Promise<SessionRuntime> {
  injectProviderEnv(context)

  const backend = await LocalShellBackend.create({
    rootDir: context.agent.workspace ?? process.cwd(),
    inheritEnv: true,
  })

  // 通过 ToolCatalog 注册 fetch_url,自动获得 runtime 的策略门、超时控制、HITL pending 与 tool.* 事件流。
  const toolCatalog = new ToolRegistry().registerTool(createFetchUrlTool())

  return createSessionRuntime({
    deepagents: {
      model: `${context.agent.provider}:${context.agent.modelName}`,
      providerConfig: {
        provider: context.agent.provider,
        model: context.agent.modelName,
        apiKey: context.agent.providerConfig?.apiKey,
        baseUrl: readProviderBaseUrl(context),
        headers: readProviderHeaders(context),
      },
      backend,
    },
    snapshotStore: context.snapshotStore,
    toolCatalog,
    logger: options?.logger,
  })
}

/**
 * Creates a session-scoped chat facade for CLI and future app entrypoints.
 *
 * @param context - The resolved agent bootstrap context
 * @returns A session wrapper that emits runtime events for each prompt
 */
export async function createAgentSession(
  context: LoadedAgentContext,
  options?: AgentRuntimeOptions
): Promise<AgentSession> {
  const runtime = await createAgentRuntime(context, options)
  const sessionId = `session_${Date.now()}` as SessionId
  let activeRunId: RunId | null = null

  return {
    sessionId,
    abort(): void {
      if (activeRunId !== null) {
        runtime.cancelRun(activeRunId)
      }
    },
    async *query(prompt: string, options?: ChatOptions): AsyncIterable<RuntimeEvent> {
      await runtime.createSession({ sessionId })

      const userMessage: AppMessage = {
        id: `msg_user_${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        createdAt: Date.now(),
      }

      const runId = await runtime.runTurn({
        sessionId,
        message: userMessage,
        systemPrompt: options?.systemPrompt ?? context.agent.soul,
      })
      activeRunId = runId

      try {
        for await (const event of runtime.streamEvents(runId)) {
          yield event
        }
      } finally {
        if (activeRunId === runId) {
          activeRunId = null
        }
      }
    },
  }
}

function readProviderBaseUrl(context: LoadedAgentContext): string | undefined {
  return typeof context.agent.providerConfig?.baseUrl === 'string'
    ? context.agent.providerConfig.baseUrl
    : undefined
}

function readProviderHeaders(context: LoadedAgentContext): Record<string, string> | undefined {
  if (
    context.agent.providerConfig?.headers === undefined ||
    context.agent.providerConfig.headers === null ||
    typeof context.agent.providerConfig.headers !== 'object'
  ) {
    return undefined
  }

  const headerEntries = Object.entries(context.agent.providerConfig.headers).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  )

  return headerEntries.length > 0 ? Object.fromEntries(headerEntries) : undefined
}
