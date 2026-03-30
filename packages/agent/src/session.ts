import { type SessionRuntime, createSessionRuntime } from '@tianji/runtime'
import type { AppMessage, RuntimeEvent, SessionId } from '@tianji/shared'

import { type LoadedAgentContext, injectProviderEnv } from './context.js'

export interface ChatOptions {
  readonly systemPrompt?: string
}

export interface AgentSession {
  readonly sessionId: SessionId
  readonly chat: (prompt: string, options?: ChatOptions) => AsyncIterable<RuntimeEvent>
}

/**
 * Creates a runtime instance from an already loaded agent context.
 *
 * @param context - The resolved agent bootstrap context
 * @returns A session runtime configured for the selected provider and model
 */
export function createAgentRuntime(context: LoadedAgentContext): SessionRuntime {
  injectProviderEnv(context)

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
    },
    snapshotStore: context.snapshotStore,
  })
}

/**
 * Creates a session-scoped chat facade for CLI and future app entrypoints.
 *
 * @param context - The resolved agent bootstrap context
 * @returns A session wrapper that emits runtime events for each prompt
 */
export function createAgentSession(context: LoadedAgentContext): AgentSession {
  const runtime = createAgentRuntime(context)
  const sessionId = `session_${Date.now()}` as SessionId

  return {
    sessionId,
    async *chat(prompt: string, options?: ChatOptions): AsyncIterable<RuntimeEvent> {
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

      for await (const event of runtime.streamEvents(runId)) {
        yield event
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
