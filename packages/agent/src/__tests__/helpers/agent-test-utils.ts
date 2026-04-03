import { FakeListChatModel } from '@langchain/core/utils/testing'
import { InMemorySnapshotStore, ToolRegistry, createSessionRuntime } from '@tianji/runtime'
import type { RuntimeEvent, SessionId } from '@tianji/shared'

import type { AgentSession, ChatOptions } from '../../session.js'

/**
 * Constructs a minimal in-memory SessionRuntime for tests, no filesystem needed.
 */
export function createTestRuntime(responses: string[]) {
  return createSessionRuntime({
    deepagents: {
      model: new FakeListChatModel({ responses }),
    },
    snapshotStore: new InMemorySnapshotStore(),
    toolCatalog: new ToolRegistry(),
  })
}

/**
 * Drives `session.chat()` to completion and returns all emitted events.
 */
export async function collectChatEvents(
  session: AgentSession,
  prompt: string,
  options?: ChatOptions
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  for await (const event of session.chat(prompt, options)) {
    events.push(event)
  }
  return events
}
