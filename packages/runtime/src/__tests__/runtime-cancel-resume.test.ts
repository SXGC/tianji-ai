/**
 * SessionRuntime 取消与恢复回归测试。
 *
 * 业务职责：
 * - 覆盖 deepagents 运行时在取消、重放恢复、带副作用恢复和 HITL 恢复场景下的状态语义。
 * - 验证 resumeHint、checkpoint 元数据与 workflowState 的持久化契约。
 *
 * 对外触点：
 * - 通过 createSessionRuntime 组装取消/恢复前后的 runtime 实例。
 * - 联动 MemorySaver、ToolRegistry 与 helpers/runtime-test-utils 验证恢复链路。
 */
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { MemorySaver } from '@langchain/langgraph'
import { type ObserverLogEntry, createMemorySink, createObserverLogger } from '@tianji/observer'
import { DEFAULT_EXECUTION_POLICY, type DomainEvent, createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { readDeepagentsRunWorkflowState, readRunRuntimeMetadata } from '../runtime.js'
import { InMemorySnapshotStore } from '../snapshot-store.js'
import { ToolRegistry } from '../tool-catalog.js'
import {
  collectRuntimeEvents,
  createAbortError,
  createDeferred,
  createTestRuntime,
  createUserMessage,
  readTextContent,
  waitForRunStatus,
} from './helpers/runtime-test-utils.js'

describe('SessionRuntime cancel/resume regressions', () => {
  it('preserves resumeHint and resumedFromRunId semantics for deepagents runs', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const toolCatalog = new ToolRegistry().registerTool({
      spec: {
        name: 'lookup',
        description: 'Look up data',
        parameters: { type: 'object' },
      },
      execute: async (_args, context) => {
        toolSignalSeen.resolve(context.abortSignal)

        await new Promise<never>((_resolve, reject) => {
          context.abortSignal?.addEventListener(
            'abort',
            () => {
              reject(createAbortError('tool cancelled cleanly'))
            },
            { once: true }
          )
        })

        throw new Error('Unreachable')
      },
      sideEffect: 'idempotent',
    })
    const cancellationRuntime = createTestRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'lookup', args: { city: 'Shanghai' }, id: 'tool-replay' },
        ]),
      },
      snapshotStore,
      toolCatalog,
    })
    const resumeRuntime = createTestRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage('resumed answer')),
      },
      snapshotStore,
      toolCatalog,
    })
    const session = await cancellationRuntime.createSession({
      sessionId: createSessionId('session-deepagents-cancel-resume'),
    })
    const cancelledRunId = await cancellationRuntime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-deepagents-cancel-resume', 'cancel then resume this run'),
      systemPrompt: 'stored prompt',
    })
    const cancelledEventsPromise = collectRuntimeEvents(cancelledRunId, cancellationRuntime)
    const toolAbortSignal = await toolSignalSeen.promise

    expect(cancellationRuntime.cancelRun(cancelledRunId)).toBe(true)

    const cancelledEvents = await cancelledEventsPromise
    const cancelledRun = await waitForRunStatus(cancellationRuntime, cancelledRunId, 'cancelled')
    const resumedRunId = await resumeRuntime.resumeRun({ runId: cancelledRunId })
    const resumedEvents = await collectRuntimeEvents(resumedRunId, resumeRuntime)
    const resumedRun = await waitForRunStatus(resumeRuntime, resumedRunId, 'completed')

    expect(toolAbortSignal?.aborted).toBe(true)
    expect(cancelledEvents.map((event) => event.type)).toEqual([
      'RunStarted',
      'MessageStarted',
      'ToolStarted',
      'RunCancelled',
    ])
    expect(cancelledRunId).not.toBe(resumedRunId)
    expect(cancelledRun.resumeHint).toBe('replay')
    expect(cancelledRun.pendingOperations).toEqual([
      {
        id: 'tool-replay',
        invocation: {
          toolCallId: 'tool-replay',
          toolName: 'lookup',
          args: { city: 'Shanghai' },
        },
        status: 'aborted-clean',
        timestamp: expect.any(Number),
      },
    ])
    expect(resumedEvents.map((event) => event.type)).toEqual([
      'RunStarted',
      'MessageStarted',
      'MessageCompleted',
      'RunCompleted',
    ])
    expect(resumedRun.metadata).toMatchObject({
      systemPrompt: 'stored prompt',
      resumedFromRunId: cancelledRunId,
    })

    const sessionSnapshot = await resumeRuntime.getSessionSnapshot(session.sessionId)
    expect(readTextContent(sessionSnapshot?.messages[1])).toBe('resumed answer')
  })

  it('records parentRunId and triggerType when resuming a cancelled run', async () => {
    const memorySink = createMemorySink()
    const logger = createObserverLogger({ sinks: [memorySink] })
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const toolCatalog = new ToolRegistry().registerTool({
      spec: {
        name: 'lookup',
        description: 'Look up data',
        parameters: { type: 'object' },
      },
      execute: async (_args, context) => {
        toolSignalSeen.resolve(context.abortSignal)

        await new Promise<never>((_resolve, reject) => {
          context.abortSignal?.addEventListener(
            'abort',
            () => {
              reject(createAbortError('tool cancelled cleanly'))
            },
            { once: true }
          )
        })

        throw new Error('Unreachable')
      },
      sideEffect: 'idempotent',
    })

    const cancellationRuntime = createTestRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'lookup', args: { city: 'Shanghai' }, id: 'tool-replay' },
        ]),
      },
      snapshotStore,
      toolCatalog,
      logger,
    })

    const resumeRuntime = createTestRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('resumed answer')) },
      snapshotStore,
      toolCatalog,
      logger,
    })

    const session = await cancellationRuntime.createSession({
      sessionId: createSessionId('session-runtime-trigger-resume'),
    })
    const cancelledRunId = await cancellationRuntime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-runtime-trigger-resume', 'cancel then resume this run'),
    })
    const cancelledEventsPromise = collectRuntimeEvents(cancelledRunId, cancellationRuntime)
    await toolSignalSeen.promise

    expect(cancellationRuntime.cancelRun(cancelledRunId)).toBe(true)

    await cancelledEventsPromise

    const resumedRunId = await resumeRuntime.resumeRun({ runId: cancelledRunId })
    const resumedRun = await waitForRunStatus(resumeRuntime, resumedRunId, 'completed')
    const resumedEvents = await collectRuntimeEvents(resumedRunId, resumeRuntime)
    const cancelledLifecycleEvents = (
      await collectRuntimeEvents(cancelledRunId, cancellationRuntime)
    ).filter(
      (event): event is Extract<DomainEvent, { type: 'RunStarted' | 'RunCancelled' }> =>
        event.type === 'RunStarted' || event.type === 'RunCancelled'
    )
    const resumedLifecycleEvents = resumedEvents.filter(
      (
        event
      ): event is Extract<DomainEvent, { type: 'RunStarted' | 'RunCompleted' | 'RunFailed' }> =>
        event.type === 'RunStarted' || event.type === 'RunCompleted' || event.type === 'RunFailed'
    )
    const runtimeRunLogEntries = memorySink.entries.filter(
      (entry: ObserverLogEntry): entry is ObserverLogEntry & { data: Record<string, unknown> } =>
        entry.scope.join('.') === 'runtime.run' &&
        (entry.message === 'run.started' ||
          entry.message === 'run.completed' ||
          entry.message === 'run.failed' ||
          entry.message === 'run.cancelled')
    )

    expect(resumedRun.triggerType).toBe('resume')
    expect(resumedRun.parentRunId).toBe(cancelledRunId)
    expect(cancelledLifecycleEvents).toEqual([
      expect.objectContaining({
        type: 'RunStarted',
        runId: cancelledRunId,
        sessionId: session.sessionId,
        triggerType: 'new',
        parentRunId: undefined,
      }),
      expect.objectContaining({
        type: 'RunCancelled',
        runId: cancelledRunId,
        sessionId: session.sessionId,
        triggerType: 'new',
        parentRunId: undefined,
      }),
    ])
    expect(resumedLifecycleEvents).toEqual([
      expect.objectContaining({
        type: 'RunStarted',
        runId: resumedRunId,
        sessionId: session.sessionId,
        triggerType: 'resume',
        parentRunId: cancelledRunId,
      }),
      expect.objectContaining({
        type: 'RunCompleted',
        runId: resumedRunId,
        sessionId: session.sessionId,
        triggerType: 'resume',
        parentRunId: cancelledRunId,
      }),
    ])

    expect(runtimeRunLogEntries).toHaveLength(
      cancelledLifecycleEvents.length + resumedLifecycleEvents.length
    )
    expect(runtimeRunLogEntries).toEqual([
      expect.objectContaining({
        level: 'info',
        message: 'run.started',
        data: expect.objectContaining({
          sessionId: session.sessionId,
          runId: cancelledRunId,
          triggerType: 'new',
        }),
      }),
      expect.objectContaining({
        level: 'warn',
        message: 'run.cancelled',
        data: expect.objectContaining({
          sessionId: session.sessionId,
          runId: cancelledRunId,
          triggerType: 'new',
        }),
      }),
      expect.objectContaining({
        level: 'info',
        message: 'run.started',
        data: expect.objectContaining({
          sessionId: session.sessionId,
          runId: resumedRunId,
          triggerType: 'resume',
          parentRunId: cancelledRunId,
        }),
      }),
      expect.objectContaining({
        level: 'info',
        message: 'run.completed',
        data: expect.objectContaining({
          sessionId: session.sessionId,
          runId: resumedRunId,
          triggerType: 'resume',
          parentRunId: cancelledRunId,
        }),
      }),
    ])
  })

  it('uses require-user-confirmation for destructive side effects in deepagents runs', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const runtime = createTestRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'delete-file', args: { path: '/tmp/test.txt' }, id: 'tool-danger' },
        ]),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry().registerTool({
        spec: {
          name: 'delete-file',
          description: 'Delete a file',
          parameters: { type: 'object' },
        },
        execute: async (_args, context) => {
          toolSignalSeen.resolve(context.abortSignal)

          await new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener(
              'abort',
              () => {
                reject(createAbortError('destructive tool cancelled'))
              },
              { once: true }
            )
          })

          throw new Error('Unreachable')
        },
        sideEffect: 'destructive',
      }),
    })
    const session = await runtime.createSession({
      sessionId: createSessionId('session-deepagents-cancel-confirmation'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-deepagents-cancel-confirmation', 'cancel destructive work'),
      policy: {
        ...DEFAULT_EXECUTION_POLICY,
        tool: {
          ...DEFAULT_EXECUTION_POLICY.tool,
          allowDestructive: true,
        },
      },
    })
    const eventsPromise = collectRuntimeEvents(runId, runtime)
    const toolAbortSignal = await toolSignalSeen.promise

    expect(runtime.cancelRun(runId)).toBe(true)

    const events = await eventsPromise
    const cancelledRun = await waitForRunStatus(runtime, runId, 'cancelled')

    expect(toolAbortSignal?.aborted).toBe(true)
    expect(events.map((event) => event.type)).toEqual([
      'RunStarted',
      'MessageStarted',
      'ToolStarted',
      'RunCancelled',
    ])
    expect(cancelledRun.resumeHint).toBe('require-user-confirmation')
    expect(cancelledRun.pendingOperations).toEqual([
      {
        id: 'tool-danger',
        invocation: {
          toolCallId: 'tool-danger',
          toolName: 'delete-file',
          args: { path: '/tmp/test.txt' },
        },
        status: 'aborted-with-side-effect',
        timestamp: expect.any(Number),
      },
    ])
  })

  it('persists checkpoint metadata and resumes HITL runs with resumeValue', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const checkpointer = new MemorySaver()
    let toolExecutions = 0
    const toolCatalog = new ToolRegistry().registerTool({
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
      execute: async (args) => {
        if (!isRecord(args)) {
          throw new Error('Expected object args')
        }

        if (typeof args.a !== 'number' || typeof args.b !== 'number') {
          throw new Error('Expected numeric args')
        }

        toolExecutions += 1
        return args.a + args.b
      },
      sideEffect: 'idempotent',
    })
    const interruptingRuntime = createTestRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'sum', args: { a: 2, b: 5 }, id: 'tool-hitl' },
        ]),
        checkpointer,
        interruptOn: {
          sum: {
            allowedDecisions: ['approve', 'reject'],
          },
        },
      },
      snapshotStore,
      toolCatalog,
    })
    const resumeRuntime = createTestRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage('approved sum 7')),
        checkpointer,
        interruptOn: {
          sum: {
            allowedDecisions: ['approve', 'reject'],
          },
        },
      },
      snapshotStore,
      toolCatalog,
    })
    const session = await interruptingRuntime.createSession({
      sessionId: createSessionId('session-deepagents-hitl-resume'),
    })
    const interruptedRunId = await interruptingRuntime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-deepagents-hitl-resume', 'sum 2 + 5 with approval'),
    })
    const interruptedEvents = await collectRuntimeEvents(interruptedRunId, interruptingRuntime)
    const interruptedRun = await waitForRunStatus(
      interruptingRuntime,
      interruptedRunId,
      'cancelled'
    )
    const interruptedMetadata = readRunRuntimeMetadata(interruptedRun.metadata)
    const workflowState = readDeepagentsRunWorkflowState(interruptedRun.workflowState)

    expect(interruptedEvents.map((event) => event.type)).toEqual([
      'RunStarted',
      'MessageStarted',
      'RunCancelled',
    ])
    expect(interruptedRun.resumeHint).toBe('require-user-confirmation')
    expect(interruptedMetadata?.threadId).toBe(session.sessionId)
    expect(interruptedMetadata?.checkpointId).toEqual(expect.any(String))
    expect(workflowState).toMatchObject({
      kind: 'deepagents-interrupt',
      threadId: session.sessionId,
      checkpointId: interruptedMetadata?.checkpointId,
      interrupts: [
        {
          value: {
            actionRequests: [
              {
                name: 'sum',
                args: { a: 2, b: 5 },
              },
            ],
          },
        },
      ],
    })
    expect(toolExecutions).toBe(0)

    const resumedRunId = await resumeRuntime.resumeRun({
      runId: interruptedRunId,
      resumeValue: {
        decisions: [{ type: 'approve' }],
      },
    })
    const resumedEvents = await collectRuntimeEvents(resumedRunId, resumeRuntime)
    const resumedRun = await waitForRunStatus(resumeRuntime, resumedRunId, 'completed')
    const resumedMetadata = readRunRuntimeMetadata(resumedRun.metadata)
    const sessionSnapshot = await resumeRuntime.getSessionSnapshot(session.sessionId)

    expect(resumedEvents.map((event) => event.type)).toEqual([
      'RunStarted',
      'MessageStarted',
      'ToolStarted',
      'ToolCompleted',
      'MessageCompleted',
      'RunCompleted',
    ])
    expect(toolExecutions).toBe(1)
    expect(resumedMetadata?.threadId).toBe(session.sessionId)
    expect(resumedMetadata?.checkpointId).toEqual(expect.any(String))
    expect(readTextContent(sessionSnapshot?.messages.at(-1))).toBe('approved sum 7')
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
