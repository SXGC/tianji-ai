/**
 * Token usage tracking 集成测试。
 *
 * 验证 deepagents engine 从 LangChain on_chat_model_end 事件中提取 usage_metadata，
 * 并在 RunSnapshot 和 SessionSnapshot 中持久化 usage 数据。
 */
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import type { TokenUsage } from '@tianji/shared'
import { createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createSessionRuntime } from '../runtime.js'
import { InMemorySnapshotStore } from '../snapshot-store.js'
import { ToolRegistry } from '../tool-catalog.js'
import {
  collectRuntimeEvents,
  createUserMessage,
  waitForRunStatus,
} from './helpers/runtime-test-utils.js'

describe('Token usage tracking', () => {
  it('records usage from a single-turn run into RunSnapshot and SessionSnapshot', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const aiMessage = new AIMessage({
      content: 'Hello!',
      usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    })

    const runtime = createSessionRuntime({
      deepagents: { model: fakeModel().respond(aiMessage) },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-usage-single'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-usage-1', 'hi'),
    })
    await collectRuntimeEvents(runId, runtime)
    const run = await waitForRunStatus(runtime, runId, 'completed')

    const runUsage = run.metadata?.usage as TokenUsage | undefined
    expect(runUsage).toBeDefined()
    expect(runUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    })

    const sessionSnapshot = await runtime.getSessionSnapshot(session.sessionId)
    const sessionUsage = sessionSnapshot?.metadata?.usage as TokenUsage | undefined
    expect(sessionUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    })
  })

  it('accumulates usage across multiple runs in the same session', async () => {
    const snapshotStore = new InMemorySnapshotStore()

    // fakeModel 的 bindTools 会重置 _callIndex，需要用外部计数器确保跨 run 返回不同响应。
    const messages = [
      new AIMessage({
        content: 'First',
        usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      }),
      new AIMessage({
        content: 'Second',
        usage_metadata: { input_tokens: 200, output_tokens: 80, total_tokens: 280 },
      }),
    ]
    let callIndex = 0
    const responder = (): AIMessage => {
      const msg = messages[callIndex % messages.length]!
      callIndex += 1
      return msg
    }

    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(responder).respond(responder),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-usage-multi'),
    })

    const runId1 = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-multi-1', 'first'),
    })
    await collectRuntimeEvents(runId1, runtime)
    await waitForRunStatus(runtime, runId1, 'completed')

    const runId2 = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-multi-2', 'second'),
    })
    await collectRuntimeEvents(runId2, runtime)
    await waitForRunStatus(runtime, runId2, 'completed')

    const run2 = await runtime.getRunSnapshot(runId2)
    expect(run2?.metadata?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      totalTokens: 280,
    })

    const sessionSnapshot = await runtime.getSessionSnapshot(session.sessionId)
    expect(sessionSnapshot?.metadata?.usage).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      totalTokens: 430,
    })
  })

  it('records zero usage when model does not provide usage_metadata', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage({ content: 'No metadata' })),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-usage-none'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-no-usage', 'hi'),
    })
    await collectRuntimeEvents(runId, runtime)
    const run = await waitForRunStatus(runtime, runId, 'completed')

    expect(run.metadata?.usage).toBeUndefined()
  })
})
