/**
 * deepagents 工具适配层测试。
 *
 * 业务职责：
 * - 验证 ToolCatalog 与 deepagents 之间的上下文透传、失败语义与超时语义一致。
 * - 防止 runtime 工具事件与 pendingOperations 状态在适配层发生漂移。
 *
 * 对外触点：
 * - 通过 createSessionRuntime 建立 deepagents runtime。
 * - 使用 ToolRegistry 与 helpers/runtime-test-utils 校验工具执行链路。
 */
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { DEFAULT_EXECUTION_POLICY, type DomainEvent, createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { InMemorySnapshotStore } from '../snapshot-store.js'
import { type RuntimeToolExecutionContext, ToolRegistry } from '../tool-catalog.js'
import {
  collectRuntimeEvents,
  collectRuntimeOutcome,
  createDeferred,
  createTestRuntime,
  createUserMessage,
  readTextContent,
  waitForRunStatus,
} from './helpers/runtime-test-utils.js'

describe('deepagents tool adapter', () => {
  it('passes sessionId runId and toolCallId through ToolCatalog', async () => {
    let observedToolContext: RuntimeToolExecutionContext | undefined
    const runtime = createTestRuntime({
      engine: 'deepagents',
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'sum', args: { a: 2, b: 5 }, id: 'call_sum' }])
          .respond(new AIMessage('Working 7')),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry().registerTool({
        spec: {
          name: 'sum',
          description: 'Add two numbers',
          parameters: {
            type: 'object',
            properties: {
              a: { type: 'number' },
              b: { type: 'number' },
            },
            required: ['a', 'b'],
          },
        },
        execute: async (args, context) => {
          observedToolContext = context

          if (typeof args !== 'object' || args === null) {
            throw new Error('Expected object args')
          }

          const candidate = args as { a?: unknown; b?: unknown }

          if (typeof candidate.a !== 'number' || typeof candidate.b !== 'number') {
            throw new Error('Expected numeric args')
          }

          return candidate.a + candidate.b
        },
        sideEffect: 'idempotent',
      }),
    })
    const session = await runtime.createSession({
      sessionId: createSessionId('session-deepagents-tool-context'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-deepagents-tool-context', 'calculate 2 + 5'),
    })
    const events = await collectRuntimeEvents(runId, runtime)
    const toolStartedEvent = events.find(
      (event): event is Extract<DomainEvent, { type: 'ToolStarted' }> =>
        event.type === 'ToolStarted'
    )
    const toolCompletedEvent = events.find(
      (event): event is Extract<DomainEvent, { type: 'ToolCompleted' }> =>
        event.type === 'ToolCompleted'
    )
    const sessionSnapshot = await runtime.getSessionSnapshot(session.sessionId)

    expect(toolStartedEvent).toMatchObject({
      runId,
      toolCallId: 'call_sum',
      invocation: {
        toolCallId: 'call_sum',
        toolName: 'sum',
        args: { a: 2, b: 5 },
      },
    })
    expect(toolCompletedEvent).toMatchObject({
      runId,
      toolCallId: 'call_sum',
      result: {
        toolCallId: 'call_sum',
        result: 7,
      },
    })
    expect(observedToolContext).toMatchObject({
      sessionId: session.sessionId,
      runId,
      toolCallId: 'call_sum',
    })
    expect(observedToolContext?.abortSignal).toBeInstanceOf(AbortSignal)
    expect(readTextContent(sessionSnapshot?.messages.at(-1))).toContain('7')
  })

  it('preserves tool failure semantics through deepagents', async () => {
    const runtime = createTestRuntime({
      engine: 'deepagents',
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'explode', args: { reason: 'boom' }, id: 'call_fail' },
        ]),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry().registerTool({
        spec: {
          name: 'explode',
          description: 'Always fail',
          parameters: {
            type: 'object',
            properties: {
              reason: { type: 'string' },
            },
            required: ['reason'],
          },
        },
        execute: async () => {
          throw new Error('tool exploded')
        },
        sideEffect: 'idempotent',
      }),
    })
    const session = await runtime.createSession({
      sessionId: createSessionId('session-deepagents-tool-failure'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-deepagents-tool-failure', 'fail the tool'),
    })
    const outcome = await collectRuntimeOutcome(runId, runtime)
    const toolFailedEvent = outcome.events.find(
      (event): event is Extract<DomainEvent, { type: 'ToolFailed' }> => event.type === 'ToolFailed'
    )
    const failedRun = await waitForRunStatus(runtime, runId, 'failed')

    expect(toolFailedEvent).toMatchObject({
      runId,
      toolCallId: 'call_fail',
      invocation: {
        toolCallId: 'call_fail',
        toolName: 'explode',
        args: { reason: 'boom' },
      },
      error: {
        code: 'TOOL_EXECUTION_FAILED',
        message: 'tool exploded',
      },
    })
    expect(outcome.events.some((event) => event.type === 'RunFailed')).toBe(true)
    expect(failedRun).toMatchObject({
      status: 'failed',
      pendingOperations: [
        {
          id: 'call_fail',
          invocation: {
            toolCallId: 'call_fail',
            toolName: 'explode',
            args: { reason: 'boom' },
          },
          status: 'aborted-clean',
          timestamp: expect.any(Number),
        },
      ],
    })
  })

  it('enforces tool timeout semantics through deepagents', async () => {
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const runtime = createTestRuntime({
      engine: 'deepagents',
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'slow-tool', args: { duration: 'forever' }, id: 'call_timeout' },
        ]),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry().registerTool({
        spec: {
          name: 'slow-tool',
          description: 'Never finishes before timeout',
          parameters: {
            type: 'object',
            properties: {
              duration: { type: 'string' },
            },
            required: ['duration'],
          },
        },
        execute: async (_args, context) => {
          toolSignalSeen.resolve(context.abortSignal)

          await new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener(
              'abort',
              () => {
                reject(new Error('tool observed timeout abort'))
              },
              { once: true }
            )
          })

          throw new Error('Unreachable')
        },
        sideEffect: 'idempotent',
      }),
    })
    const session = await runtime.createSession({
      sessionId: createSessionId('session-deepagents-tool-timeout'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-deepagents-tool-timeout', 'time out the tool'),
      policy: {
        ...DEFAULT_EXECUTION_POLICY,
        tool: {
          ...DEFAULT_EXECUTION_POLICY.tool,
          timeoutMs: 10,
        },
      },
    })
    const outcome = await collectRuntimeOutcome(runId, runtime)
    const toolFailedEvent = outcome.events.find(
      (event): event is Extract<DomainEvent, { type: 'ToolFailed' }> => event.type === 'ToolFailed'
    )
    const failedRun = await waitForRunStatus(runtime, runId, 'failed')
    const observedAbortSignal = await toolSignalSeen.promise

    expect(observedAbortSignal?.aborted).toBe(true)
    expect(toolFailedEvent).toMatchObject({
      runId,
      toolCallId: 'call_timeout',
      error: {
        code: 'TOOL_TIMEOUT',
      },
    })
    expect(outcome.events.some((event) => event.type === 'RunFailed')).toBe(true)
    expect(failedRun).toMatchObject({
      status: 'failed',
      pendingOperations: [
        {
          id: 'call_timeout',
          invocation: {
            toolCallId: 'call_timeout',
            toolName: 'slow-tool',
            args: { duration: 'forever' },
          },
          status: 'aborted-clean',
          timestamp: expect.any(Number),
        },
      ],
    })
  })
})
