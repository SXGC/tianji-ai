/**
 * SessionRuntime 主链路集成测试。
 *
 * 业务职责：
 * - 验证单轮对话、工具调用、消息流式输出与快照持久化的端到端行为。
 * - 作为 deepagents 运行时基础能力的主回归覆盖。
 *
 * 对外触点：
 * - 通过 createSessionRuntime、InMemorySnapshotStore、ToolRegistry 组装真实运行时。
 * - 借助 helpers/runtime-test-utils 读取事件流与消息文本内容。
 */
import { AIMessage, AIMessageChunk } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { FakeStreamingChatModel } from '@langchain/core/utils/testing'
import { ChatOpenAI } from '@langchain/openai'
import { type RuntimeEvent, createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createSessionRuntime } from '../runtime.js'
import { InMemorySnapshotStore } from '../snapshot-store.js'
import { ToolRegistry } from '../tool-catalog.js'
import {
  collectRuntimeEvents,
  collectRuntimeEventsWithAggregation,
  createUserMessage,
  readTextContent,
} from './helpers/runtime-test-utils.js'

describe('SessionRuntime', () => {
  it('runs a single-turn conversation end to end and persists tool execution state', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolRegistry = new ToolRegistry().registerTool({
      spec: {
        name: 'sum',
        description: 'Add two numbers',
        parameters: { type: 'object' },
      },
      execute: async (args) => {
        if (typeof args !== 'object' || args === null) {
          throw new Error('Expected sum args to be an object')
        }

        const candidate = args as { a?: unknown; b?: unknown }
        if (typeof candidate.a !== 'number' || typeof candidate.b !== 'number') {
          throw new Error('Expected numeric sum args')
        }

        return candidate.a + candidate.b
      },
      sideEffect: 'idempotent',
    })

    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'sum', args: { a: 1, b: 2 }, id: 'tool-1' }])
          .respond(new AIMessage('Calculating result 3')),
      },
      snapshotStore,
      toolCatalog: toolRegistry,
    })

    const session = await runtime.createSession({ sessionId: createSessionId('session-runtime') })
    const userMessage = createUserMessage('msg-user', 'What is 1 + 2?')

    const runId = await runtime.runTurn({ sessionId: session.sessionId, message: userMessage })
    const events = await collectRuntimeEvents(runId, runtime)
    const runStartedEvent = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'run.started' }> =>
        event.type === 'run.started'
    )
    const messageStartedEvent = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'message.started' }> =>
        event.type === 'message.started'
    )
    const messageCompletedEvent = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'message.completed' }> =>
        event.type === 'message.completed'
    )

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.started',
      'tool.started',
      'tool.completed',
      'message.completed',
      'run.completed',
    ])
    expect(runStartedEvent).toMatchObject({ runId, sessionId: session.sessionId })
    expect(messageStartedEvent?.message.content).toEqual([])

    const toolStartedEvent = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'tool.started' }> =>
        event.type === 'tool.started'
    )
    expect(toolStartedEvent?.toolCallId).toBe('tool-1')
    expect(toolStartedEvent?.invocation.toolName).toBe('sum')

    const toolCompletedEvent = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'tool.completed' }> =>
        event.type === 'tool.completed'
    )
    expect(toolCompletedEvent?.toolCallId).toBe('tool-1')
    expect(toolCompletedEvent?.result.result).toBe(3)
    expect(toolCompletedEvent?.runId).toBe(runId)

    const runSnapshot = await runtime.getRunSnapshot(runId)
    expect(runSnapshot?.status).toBe('completed')
    expect(runSnapshot?.pendingOperations).toEqual([
      {
        id: 'tool-1',
        invocation: {
          toolCallId: 'tool-1',
          toolName: 'sum',
          args: { a: 1, b: 2 },
        },
        status: 'completed',
        timestamp: expect.any(Number),
      },
    ])

    const sessionSnapshot = await runtime.getSessionSnapshot(session.sessionId)
    expect(sessionSnapshot?.messages).toHaveLength(2)
    expect(readTextContent(sessionSnapshot?.messages[1] ?? userMessage)).toBe('3')
    expect(readTextContent(messageCompletedEvent?.message)).toBe('3')
  })

  it('replays streamed deltas in order and stores the aggregated final assistant message', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createSessionRuntime({
      deepagents: {
        model: new FakeStreamingChatModel({
          chunks: ['hel', 'lo ', 'world'].map((content) => new AIMessageChunk({ content })),
          responses: [],
        }),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const session = await runtime.createSession({ sessionId: createSessionId('session-streaming') })
    const userMessage = createUserMessage('msg-streaming-user', 'say hello world')

    const runId = await runtime.runTurn({ sessionId: session.sessionId, message: userMessage })
    const { events, aggregatedAssistantMessage } = await collectRuntimeEventsWithAggregation(
      runId,
      runtime
    )
    const deltaEvents = events.filter(
      (event): event is Extract<RuntimeEvent, { type: 'message.delta' }> =>
        event.type === 'message.delta'
    )
    const completedEvent = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'message.completed' }> =>
        event.type === 'message.completed'
    )
    const startedEvent = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'message.started' }> =>
        event.type === 'message.started'
    )

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.started',
      'message.delta',
      'message.delta',
      'message.delta',
      'message.completed',
      'run.completed',
    ])
    expect(deltaEvents.map((event) => event.sequence)).toEqual([1, 2, 3])
    expect(deltaEvents.map((event) => event.payload.content)).toEqual(['hel', 'lo ', 'world'])
    expect(readTextContent(aggregatedAssistantMessage?.message ?? userMessage)).toBe('hello world')
    expect(completedEvent?.messageId).toBe(startedEvent?.messageId)
    expect(readTextContent(completedEvent?.message ?? userMessage)).toBe('hello world')

    const runSnapshot = await runtime.getRunSnapshot(runId)
    expect(runSnapshot?.status).toBe('completed')
    expect(readTextContent(runSnapshot?.messages[1] ?? userMessage)).toBe('hello world')
  })

  it('promotes openai provider config with baseUrl into a ChatOpenAI model', () => {
    const runtime = createSessionRuntime({
      deepagents: {
        model: 'openai:gpt-latest-medium',
        providerConfig: {
          provider: 'openai',
          model: 'gpt-latest-medium',
          apiKey: 'test-key',
          baseUrl: 'http://example.test/v1',
          headers: {
            'x-test-header': 'enabled',
          },
        },
      },
    })

    const runtimeRecord = runtime as unknown as {
      options?: {
        deepagents?: {
          model?: unknown
        }
      }
    }

    expect(runtimeRecord.options?.deepagents?.model).toBeInstanceOf(ChatOpenAI)
  })
})
