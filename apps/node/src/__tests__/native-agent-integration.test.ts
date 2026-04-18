import type { UnifiedRuntimeEntry } from '@tianji/agent'
import {
  CausalContext,
  NoopSequenceRecoverer,
  SequenceCounter,
  createRuntimeEventPipeline,
} from '@tianji/runtime'
import {
  type DomainEvent,
  type DomainEventEnvelope,
  type TaskRunCommand,
  createNodeId,
  createTaskId,
} from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import { TaskExecutor } from '../task/task-executor.js'
import {
  messageDeltaEvent,
  runCompletedEvent,
  toolCompletedEvent,
  toolStartedEvent,
} from './helpers/native-agent-test-utils.js'

function createTaskRunCommand(
  taskId: ReturnType<typeof createTaskId>,
  goal: string
): TaskRunCommand {
  return {
    commandId: `command-${taskId}` as never,
    nodeId: createNodeId('node-test'),
    type: 'task.run',
    state: 'pending',
    createdAt: Date.now(),
    payload: {
      taskId,
      agentId: 'default',
      goal,
    },
  }
}

function createEnvelopeCollector() {
  const publishedEnvelopes: DomainEventEnvelope[] = []
  const contextRef = { current: CausalContext.root('task-correlation') }
  const pipeline = createRuntimeEventPipeline({
    publish: (env) => publishedEnvelopes.push(env),
    counter: new SequenceCounter(),
    contextProvider: {
      getCurrent: () => contextRef.current,
      update: (next) => {
        contextRef.current = next
      },
    },
    source: { processKind: 'node', processId: 'test-node', nodeId: createNodeId('node-test') },
    recoverer: NoopSequenceRecoverer,
  })

  return {
    publishedEnvelopes,
    emitEvent: (event: DomainEvent) => pipeline.emitEvent(event),
  }
}

function assertNoSyntheticRunEnvelopes(publishedEnvelopes: DomainEventEnvelope[]): void {
  const runEnvelopes = publishedEnvelopes.filter((env) => env.aggregateType === 'Run')
  expect(runEnvelopes.length).toBeGreaterThan(0)
  expect(runEnvelopes.every((env) => !env.eventId.startsWith('inproc_'))).toBe(true)
  expect(runEnvelopes.every((env) => !env.eventId.startsWith('acp_'))).toBe(true)
  expect(runEnvelopes.every((env) => !env.eventId.startsWith('runner_'))).toBe(true)
  expect(runEnvelopes.every((env) => env.sequence >= 1)).toBe(true)

  for (let index = 1; index < runEnvelopes.length; index += 1) {
    expect(runEnvelopes[index].sequence).toBeGreaterThanOrEqual(runEnvelopes[index - 1].sequence)
  }
}

function createUnifiedEntry(events: readonly DomainEvent[]): UnifiedRuntimeEntry {
  return {
    run: vi.fn(async () => ({
      sessionId: 'session-test' as never,
      runId: 'run-test' as never,
      events: (async function* () {
        for (const event of events) {
          yield event
        }
      })(),
    })),
    resume: vi.fn(),
    cancel: vi.fn(async () => undefined),
    stream: vi.fn(),
  }
}

describe('TaskExecutor + unified entry integration', () => {
  it('emits TaskStarted/TaskCompleted and runtime events on success', async () => {
    const events: DomainEvent[] = [messageDeltaEvent(), runCompletedEvent()]
    const stateChanges: string[] = []
    const emittedEvents: DomainEvent[] = []
    const { publishedEnvelopes, emitEvent } = createEnvelopeCollector()

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: (s) => stateChanges.push(s),
      enterCorrelation: async (_correlationId, fn) => fn(),
      emitEvent: async (ev) => {
        emittedEvents.push(ev)
        await emitEvent(ev)
      },
      createUnifiedEntry: async () => createUnifiedEntry(events),
    })

    expect(executor.executionState).toBe('idle')

    const taskId = createTaskId('task-001')
    await executor.execute(createTaskRunCommand(taskId, 'do something'))

    expect(stateChanges).toEqual(['busy', 'idle'])
    expect(executor.executionState).toBe('idle')
    expect(executor.currentTaskId).toBeNull()

    const emittedTypes = emittedEvents.map((e) => e.type)
    expect(emittedTypes).toContain('TaskStarted')
    expect(emittedTypes).toContain('MessageDelta')
    expect(emittedTypes).toContain('RunCompleted')
    expect(emittedTypes).toContain('TaskCompleted')
    expect(emittedTypes).not.toContain('TaskFailed')
    assertNoSyntheticRunEnvelopes(publishedEnvelopes)
  })

  it('publishes tool events as agent events', async () => {
    const events: DomainEvent[] = [toolStartedEvent(), toolCompletedEvent(), runCompletedEvent()]
    const emittedEvents: DomainEvent[] = []

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: () => undefined,
      enterCorrelation: async (_correlationId, fn) => fn(),
      emitEvent: (event) => emittedEvents.push(event),
      createUnifiedEntry: async () => createUnifiedEntry(events),
    })

    await executor.execute(createTaskRunCommand(createTaskId('task-002'), 'use tools'))

    expect(emittedEvents.map((e) => e.type)).toEqual([
      'TaskStarted',
      'ToolStarted',
      'ToolCompleted',
      'RunCompleted',
      'TaskCompleted',
    ])
  })

  it('preserves repeated RunCompleted events from unified entry stream', async () => {
    const events: DomainEvent[] = [runCompletedEvent(), runCompletedEvent(), runCompletedEvent()]
    const emittedEvents: DomainEvent[] = []

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: () => undefined,
      enterCorrelation: async (_correlationId, fn) => fn(),
      emitEvent: (event) => emittedEvents.push(event),
      createUnifiedEntry: async () => createUnifiedEntry(events),
    })

    await executor.execute(createTaskRunCommand(createTaskId('task-003'), 'duplicate test'))

    expect(emittedEvents.map((event) => event.type)).toEqual([
      'TaskStarted',
      'RunCompleted',
      'RunCompleted',
      'RunCompleted',
      'TaskCompleted',
    ])
  })

  it('maps cancel-triggered GraphRunCancelled from unified entry to TaskCancelled', async () => {
    const stateChanges: string[] = []
    const emittedEvents: DomainEvent[] = []

    const createUnifiedEntryWithCancelableGraph = (): UnifiedRuntimeEntry => {
      let cancelled = false
      let resolveWaiter: (() => void) | undefined

      return {
        run: vi.fn(async () => ({
          sessionId: 'session-test' as never,
          runId: 'run-test' as never,
          events: (async function* () {
            const startedEvent: DomainEvent = {
              type: 'GraphRunStarted',
              runId: 'run-test' as never,
              graphId: 'default',
              graphVersion: 1,
              mermaidDiagram: '',
              timestamp: Date.now(),
            }
            yield startedEvent

            if (!cancelled) {
              await new Promise<void>((resolve) => {
                resolveWaiter = resolve
              })
            }

            const cancelledEvent: DomainEvent = {
              type: 'GraphRunCancelled',
              runId: 'run-test' as never,
              graphId: 'default',
              graphVersion: 1,
              reason: 'abort',
              timestamp: Date.now(),
            }
            yield cancelledEvent
          })(),
        })),
        resume: vi.fn(),
        cancel: vi.fn(async () => {
          cancelled = true
          resolveWaiter?.()
        }),
        stream: vi.fn(),
      }
    }

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: (state) => stateChanges.push(state),
      enterCorrelation: async (_correlationId, fn) => fn(),
      emitEvent: (event) => emittedEvents.push(event),
      createUnifiedEntry: async () => createUnifiedEntryWithCancelableGraph(),
    })

    const executionPromise = executor.execute(
      createTaskRunCommand(createTaskId('task-cancel-graph'), 'cancel graph run')
    )

    while (!emittedEvents.some((event) => event.type === 'GraphRunStarted')) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    executor.cancel()

    await executionPromise

    expect(emittedEvents.map((event) => event.type)).toEqual([
      'TaskStarted',
      'GraphRunStarted',
      'GraphRunCancelled',
      'TaskCancelled',
    ])
    expect(stateChanges).toEqual(['busy', 'idle'])
  })
})
