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
import { type ObserverLogEntry, createMemorySink, createObserverLogger } from '@tianji/observer'
import { type DomainEvent, createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { InMemorySnapshotStore } from '../snapshot-store.js'
import { ToolRegistry } from '../tool-catalog.js'
import {
  collectRuntimeEvents,
  collectRuntimeEventsWithAggregation,
  createTestRuntime,
  createUserMessage,
  readTextContent,
  waitForRunStatus,
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

    const runtime = createTestRuntime({
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
      (event): event is Extract<DomainEvent, { type: 'RunStarted' }> => event.type === 'RunStarted'
    )
    const messageStartedEvent = events.find(
      (event): event is Extract<DomainEvent, { type: 'MessageStarted' }> =>
        event.type === 'MessageStarted'
    )
    const messageCompletedEvent = events.find(
      (event): event is Extract<DomainEvent, { type: 'MessageCompleted' }> =>
        event.type === 'MessageCompleted'
    )

    expect(events.map((event) => event.type)).toEqual([
      'RunStarted',
      'MessageStarted',
      'ToolStarted',
      'ToolCompleted',
      'MessageCompleted',
      'RunCompleted',
    ])
    expect(runStartedEvent).toMatchObject({ runId, sessionId: session.sessionId })
    expect(messageStartedEvent?.message.content).toEqual([])

    const toolStartedEvent = events.find(
      (event): event is Extract<DomainEvent, { type: 'ToolStarted' }> =>
        event.type === 'ToolStarted'
    )
    expect(toolStartedEvent?.toolCallId).toBe('tool-1')
    expect(toolStartedEvent?.invocation.toolName).toBe('sum')

    const toolCompletedEvent = events.find(
      (event): event is Extract<DomainEvent, { type: 'ToolCompleted' }> =>
        event.type === 'ToolCompleted'
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
    // user + assistant(tool-call) + tool(tool-result) + assistant(final text)
    expect(sessionSnapshot?.messages).toHaveLength(4)
    expect(sessionSnapshot?.messages[1]?.role).toBe('assistant')
    expect(sessionSnapshot?.messages[1]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool-call', toolCallId: 'tool-1', toolName: 'sum' }),
      ])
    )
    expect(sessionSnapshot?.messages[2]?.role).toBe('tool')
    expect(sessionSnapshot?.messages[2]?.content).toEqual([
      expect.objectContaining({
        type: 'tool-result',
        toolCallId: 'tool-1',
        toolName: 'sum',
        result: 3,
        isError: false,
      }),
    ])
    expect(readTextContent(sessionSnapshot?.messages[3] ?? userMessage)).toBe('3')
    expect(readTextContent(messageCompletedEvent?.message)).toBe('3')
  })

  it('replays streamed deltas in order and stores the aggregated final assistant message', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createTestRuntime({
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
      (event): event is Extract<DomainEvent, { type: 'MessageDelta' }> =>
        event.type === 'MessageDelta'
    )
    const completedEvent = events.find(
      (event): event is Extract<DomainEvent, { type: 'MessageCompleted' }> =>
        event.type === 'MessageCompleted'
    )
    const startedEvent = events.find(
      (event): event is Extract<DomainEvent, { type: 'MessageStarted' }> =>
        event.type === 'MessageStarted'
    )

    expect(events.map((event) => event.type)).toEqual([
      'RunStarted',
      'MessageStarted',
      'MessageDelta',
      'MessageDelta',
      'MessageDelta',
      'MessageCompleted',
      'RunCompleted',
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

  it('marks new runs with triggerType new and no parentRunId', async () => {
    const memorySink = createMemorySink()
    const runtime = createTestRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('ok')) },
      logger: createObserverLogger({ sinks: [memorySink] }),
    })
    const session = await runtime.createSession({
      sessionId: createSessionId('session-runtime-trigger-new'),
    })

    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-runtime-trigger-new', 'hello'),
    })

    const events = await collectRuntimeEvents(runId, runtime)
    const run = await waitForRunStatus(runtime, runId, 'completed')
    const lifecycleEvents = events.filter(
      (
        event
      ): event is Extract<DomainEvent, { type: 'RunStarted' | 'RunCompleted' | 'RunFailed' }> =>
        event.type === 'RunStarted' || event.type === 'RunCompleted' || event.type === 'RunFailed'
    )
    const runtimeRunLogEntries = memorySink.entries.filter(
      (entry: ObserverLogEntry): entry is ObserverLogEntry & { data: Record<string, unknown> } =>
        entry.scope.join('.') === 'runtime.run'
    )

    expect(run.triggerType).toBe('new')
    expect(run.parentRunId).toBeUndefined()
    expect(lifecycleEvents).toEqual([
      expect.objectContaining({
        type: 'RunStarted',
        runId,
        sessionId: session.sessionId,
        triggerType: 'new',
        parentRunId: undefined,
      }),
      expect.objectContaining({
        type: 'RunCompleted',
        runId,
        sessionId: session.sessionId,
        triggerType: 'new',
        parentRunId: undefined,
      }),
    ])
    expect(runtimeRunLogEntries).toHaveLength(lifecycleEvents.length)
    expect(
      runtimeRunLogEntries.map((entry: ObserverLogEntry & { data: Record<string, unknown> }) => ({
        message: entry.message,
        sessionId: entry.data.sessionId,
        runId: entry.data.runId,
        triggerType: entry.data.triggerType,
        parentRunId: entry.data.parentRunId,
      }))
    ).toEqual([
      {
        message: 'run.started',
        sessionId: session.sessionId,
        runId,
        triggerType: 'new',
        parentRunId: undefined,
      },
      {
        message: 'run.completed',
        sessionId: session.sessionId,
        runId,
        triggerType: 'new',
        parentRunId: undefined,
      },
    ])
  })

  it('keeps failed lifecycle events and observer logs in the same lineage order', async () => {
    const memorySink = createMemorySink()
    const runtime = createTestRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([{ name: 'explode', args: {}, id: 'tool-fail' }]),
      },
      toolCatalog: new ToolRegistry().registerTool({
        spec: {
          name: 'explode',
          description: 'Always fail',
          parameters: { type: 'object' },
        },
        execute: async () => {
          throw new Error('boom')
        },
        sideEffect: 'idempotent',
      }),
      logger: createObserverLogger({ sinks: [memorySink] }),
    })
    const session = await runtime.createSession({
      sessionId: createSessionId('session-runtime-trigger-failed'),
    })

    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-runtime-trigger-failed', 'fail this run'),
    })

    await expect(collectRuntimeEvents(runId, runtime)).rejects.toThrow('boom')

    const failedRun = await waitForRunStatus(runtime, runId, 'failed')
    const runtimeRunLogEntries = memorySink.entries.filter(
      (entry: ObserverLogEntry): entry is ObserverLogEntry & { data: Record<string, unknown> } =>
        entry.scope.join('.') === 'runtime.run'
    )

    expect(failedRun.triggerType).toBe('new')
    expect(failedRun.parentRunId).toBeUndefined()
    expect(runtimeRunLogEntries).toEqual([
      expect.objectContaining({
        level: 'info',
        message: 'run.started',
        data: expect.objectContaining({
          sessionId: session.sessionId,
          runId,
          triggerType: 'new',
        }),
      }),
      expect.objectContaining({
        level: 'error',
        message: 'run.failed',
        data: expect.objectContaining({
          sessionId: session.sessionId,
          runId,
          triggerType: 'new',
          errorCode: 'ToolError',
        }),
      }),
    ])
  })

  it('promotes openai provider config with baseUrl into a ChatOpenAI model', () => {
    const runtime = createTestRuntime({
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

  it('throws when openSession targets a missing session', async () => {
    const runtime = createTestRuntime({
      deepagents: { model: fakeModel() },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry(),
    })

    await expect(runtime.openSession(createSessionId('session-missing'))).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    })
  })

  it('openSession returns existing snapshot without resetting messages', async () => {
    const sessionId = createSessionId('session-existing')
    const runtime = createTestRuntime({
      deepagents: { model: fakeModel() },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry(),
    })

    await runtime.createSession({
      sessionId,
      messages: [createUserMessage('msg-existing', 'hello')],
    })

    const opened = await runtime.openSession(sessionId)

    expect(opened.messages).toHaveLength(1)
    expect(opened.messages[0]?.role).toBe('user')
  })

  it('emits observer tool logs with consistent toolCallId across started and completed', async () => {
    const memorySink = createMemorySink()
    const toolRegistry = new ToolRegistry().registerTool({
      spec: {
        name: 'greet',
        description: 'Say hello',
        parameters: { type: 'object' },
      },
      execute: async () => 'hello',
      sideEffect: 'none',
    })

    const runtime = createTestRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'greet', args: {}, id: 'greet-1' }])
          .respond(new AIMessage('Done')),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: toolRegistry,
      logger: createObserverLogger({ sinks: [memorySink] }),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-tool-observer'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-tool-observer', 'greet me'),
    })
    await collectRuntimeEvents(runId, runtime)

    const toolLogEntries = memorySink.entries.filter(
      (entry: ObserverLogEntry): entry is ObserverLogEntry & { data: Record<string, unknown> } =>
        entry.scope.join('.') === 'runtime.tool'
    )
    const startedLog = toolLogEntries.find((entry) => entry.message === 'tool.started')
    const completedLog = toolLogEntries.find((entry) => entry.message === 'tool.completed')

    expect(startedLog).toBeDefined()
    expect(completedLog).toBeDefined()
    expect(startedLog?.data.toolCallId).toBe(completedLog?.data.toolCallId)
    expect(startedLog?.data.toolName).toBe('greet')
    expect(completedLog?.data.result).toBe('hello')
  })
})
