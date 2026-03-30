/**
 * SessionRuntime deepagents 事件语义对齐测试。
 *
 * 业务职责：
 * - 验证晚订阅事件回放、tool.failed 语义、工具执行上下文注入与执行顺序稳定性。
 * - 作为 deepagents 适配层与运行时公开事件契约的一致性回归。
 *
 * 对外触点：
 * - 使用 createRuntimeHarness 组装测试运行时。
 * - 依赖 helpers/runtime-test-utils 收集事件、聚合结果并轮询快照状态。
 */
import { AIMessage, AIMessageChunk } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { FakeStreamingChatModel } from '@langchain/core/utils/testing'
import { type RuntimeEvent, createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { InMemorySnapshotStore } from '../snapshot-store.js'
import { type RuntimeToolExecutionContext, ToolRegistry } from '../tool-catalog.js'
import {
  collectRuntimeEvents,
  collectRuntimeOutcome,
  createRuntimeHarness,
  createUserMessage,
  readTextContent,
  waitForRunStatus,
} from './helpers/runtime-test-utils.js'

describe('SessionRuntime deepagents regressions', () => {
  it('replays buffered events to late subscribers through runtime.streamEvents()', async () => {
    const runtime = createRuntimeHarness({
      deepagents: {
        model: new FakeStreamingChatModel({
          chunks: [
            new AIMessageChunk({ content: 'hello ' }),
            new AIMessageChunk({ content: 'again' }),
          ],
          responses: [],
        }),
      },
    })
    const session = await runtime.createSession({
      sessionId: createSessionId('session-late-replay'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-late-replay', 'say hello again'),
    })

    await waitForRunStatus(runtime, runId, 'completed')

    const lateSubscriberEvents = await collectRuntimeEvents(runId, runtime)
    const secondLateSubscriberEvents = await collectRuntimeEvents(runId, runtime)
    const completedEvent = lateSubscriberEvents.find(
      (event): event is Extract<RuntimeEvent, { type: 'message.completed' }> =>
        event.type === 'message.completed'
    )

    expect(lateSubscriberEvents.map((event) => event.type)).toEqual([
      'run.started',
      'message.started',
      'message.delta',
      'message.delta',
      'message.completed',
      'run.completed',
    ])
    expect(lateSubscriberEvents).toEqual(secondLateSubscriberEvents)
    expect(
      lateSubscriberEvents
        .filter(
          (event): event is Extract<RuntimeEvent, { type: 'message.delta' }> =>
            event.type === 'message.delta'
        )
        .map((event) => event.payload.content)
    ).toEqual(['hello ', 'again'])
    expect(readTextContent(completedEvent?.message)).toBe('hello again')
  })

  it('emits stable tool.failed semantics', async () => {
    const runtime = createRuntimeHarness({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'explode', args: { reason: 'boom' }, id: 'tool-fail' },
        ]),
      },
      toolCatalog: new ToolRegistry().registerTool({
        spec: {
          name: 'explode',
          description: 'Always fail',
          parameters: { type: 'object' },
        },
        execute: async () => {
          throw new Error('tool exploded')
        },
        sideEffect: 'idempotent',
      }),
    })
    const session = await runtime.createSession({
      sessionId: createSessionId('session-tool-failure'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-tool-failure', 'fail the tool'),
    })
    const outcome = await collectRuntimeOutcome(runId, runtime)
    const toolFailedEvent = outcome.events.find(
      (event): event is Extract<RuntimeEvent, { type: 'tool.failed' }> =>
        event.type === 'tool.failed'
    )
    const failedRun = await waitForRunStatus(runtime, runId, 'failed')

    expect(outcome.events.map((event) => event.type)).toEqual([
      'run.started',
      'message.started',
      'tool.started',
      'tool.failed',
      'run.failed',
    ])
    expect(toolFailedEvent).toMatchObject({
      runId,
      toolCallId: 'tool-fail',
      invocation: {
        toolCallId: 'tool-fail',
        toolName: 'explode',
        args: { reason: 'boom' },
      },
      error: {
        name: 'ToolError',
        category: 'tool',
        code: 'TOOL_EXECUTION_FAILED',
        message: 'tool exploded',
      },
    })
    expect(failedRun).toMatchObject({
      status: 'failed',
      pendingOperations: [
        {
          id: 'tool-fail',
          invocation: {
            toolCallId: 'tool-fail',
            toolName: 'explode',
            args: { reason: 'boom' },
          },
          status: 'aborted-clean',
          timestamp: expect.any(Number),
        },
      ],
    })
  })

  it('preserves tool success ordering and injects runtime tool context', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    let observedToolContext: RuntimeToolExecutionContext | undefined
    const toolRegistry = new ToolRegistry().registerTool({
      spec: {
        name: 'sum',
        description: 'Add two numbers',
        parameters: { type: 'object' },
      },
      execute: async (args, context) => {
        observedToolContext = context

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
    const runtime = createRuntimeHarness({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'sum', args: { a: 2, b: 5 }, id: 'tool-context' }])
          .respond(new AIMessage('7')),
      },
      snapshotStore,
      toolCatalog: toolRegistry,
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-tool-context'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-tool-context', 'calculate 2 + 5'),
    })
    const events = await collectRuntimeEvents(runId, runtime)
    const toolStartedEvent = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'tool.started' }> =>
        event.type === 'tool.started'
    )
    const toolCompletedEvent = events.find(
      (event): event is Extract<RuntimeEvent, { type: 'tool.completed' }> =>
        event.type === 'tool.completed'
    )

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.started',
      'tool.started',
      'tool.completed',
      'message.completed',
      'run.completed',
    ])
    expect(toolStartedEvent).toMatchObject({
      runId,
      toolCallId: 'tool-context',
      invocation: {
        toolCallId: 'tool-context',
        toolName: 'sum',
        args: { a: 2, b: 5 },
      },
    })
    expect(toolCompletedEvent).toMatchObject({
      runId,
      toolCallId: 'tool-context',
      result: {
        toolCallId: 'tool-context',
        result: 7,
      },
    })
    expect(observedToolContext).toMatchObject({
      sessionId: session.sessionId,
      runId,
      toolCallId: 'tool-context',
    })
    expect(observedToolContext?.abortSignal).toBeInstanceOf(AbortSignal)
    expect(observedToolContext?.abortSignal?.aborted).toBe(false)

    const sessionSnapshot = await runtime.getSessionSnapshot(session.sessionId)
    expect(readTextContent(sessionSnapshot?.messages[1])).toBe('7')
  })
})
