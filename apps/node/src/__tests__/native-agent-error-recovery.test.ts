import type { UnifiedRuntimeEntry } from '@tianji/agent'
import {
  type DomainEvent,
  type TaskRunCommand,
  TianjiError,
  createNodeId,
  createTaskId,
} from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import { TaskExecutor } from '../task/task-executor.js'
import { messageDeltaEvent, runCompletedEvent } from './helpers/native-agent-test-utils.js'

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

function createUnifiedEntry(
  events: readonly DomainEvent[],
  runSpy?: ReturnType<typeof vi.fn>
): UnifiedRuntimeEntry {
  return {
    run:
      runSpy ??
      vi.fn(async () => ({
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

describe('TaskExecutor error recovery and resource cleanup', () => {
  it('leaves executor stuck busy when unified entry creation fails before run handle exists', async () => {
    const stateChanges: string[] = []
    const emittedEvents: DomainEvent[] = []

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: (s) => stateChanges.push(s),
      enterCorrelation: async (_correlationId, fn) => fn(),
      emitEvent: (ev) => emittedEvents.push(ev),
      createUnifiedEntry: async () => {
        throw new Error('agent config not found')
      },
    })

    const taskId = createTaskId('task-err-001')
    await expect(
      executor.execute(createTaskRunCommand(taskId, 'fail at entry creation'))
    ).rejects.toThrow('agent config not found')

    expect(stateChanges).toEqual(['busy'])
    expect(executor.executionState).toBe('busy')
    expect(executor.currentTaskId).toBe(String(taskId))

    const lifecycleTypes = emittedEvents.map((e) => e.type)
    expect(lifecycleTypes).not.toContain('TaskStarted')
    expect(lifecycleTypes).not.toContain('TaskFailed')
    expect(lifecycleTypes).not.toContain('TaskCompleted')
  })

  it('recovers to idle when unified entry event stream fails mid-stream', async () => {
    const stateChanges: string[] = []
    const emittedEvents: DomainEvent[] = []
    const failure = new Error('provider rate limited')

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: (s) => stateChanges.push(s),
      enterCorrelation: async (_correlationId, fn) => fn(),
      emitEvent: (ev) => emittedEvents.push(ev),
      createUnifiedEntry: async () => ({
        run: vi.fn(async () => ({
          sessionId: 'session-test' as never,
          runId: 'run-test' as never,
          events: (async function* () {
            yield messageDeltaEvent()
            throw failure
          })(),
        })),
        resume: vi.fn(),
        cancel: vi.fn(async () => undefined),
        stream: vi.fn(),
      }),
    })

    const taskId = createTaskId('task-err-002')
    await expect(executor.execute(createTaskRunCommand(taskId, 'fail mid-stream'))).rejects.toThrow(
      'provider rate limited'
    )

    expect(emittedEvents.map((event) => event.type)).toEqual([
      'TaskStarted',
      'MessageDelta',
      'TaskMessageDelta',
      'TaskFailed',
    ])
    expect(stateChanges).toEqual(['busy', 'idle'])
    expect(executor.executionState).toBe('idle')
    expect(executor.currentTaskId).toBeNull()
  })

  it('executor is reusable after a stream failure that still reaches finally cleanup', async () => {
    const stateChanges: string[] = []
    const emittedEvents: DomainEvent[] = []

    const createUnifiedEntryMock = vi
      .fn<() => Promise<UnifiedRuntimeEntry>>()
      .mockResolvedValueOnce({
        run: vi.fn(async () => ({
          sessionId: 'session-test' as never,
          runId: 'run-test' as never,
          events: (async function* () {
            yield messageDeltaEvent()
            throw new TianjiError('provider', 'TRANSIENT_FAILURE', 'transient failure')
          })(),
        })),
        resume: vi.fn(),
        cancel: vi.fn(async () => undefined),
        stream: vi.fn(),
      })
      .mockResolvedValueOnce(createUnifiedEntry([messageDeltaEvent(), runCompletedEvent()]))

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: (s) => stateChanges.push(s),
      enterCorrelation: async (_correlationId, fn) => fn(),
      emitEvent: (ev) => emittedEvents.push(ev),
      createUnifiedEntry: createUnifiedEntryMock,
    })

    const taskId1 = createTaskId('task-err-003a')
    await expect(executor.execute(createTaskRunCommand(taskId1, 'will fail'))).rejects.toThrow(
      'transient failure'
    )

    const taskId2 = createTaskId('task-err-003b')
    await executor.execute(createTaskRunCommand(taskId2, 'will succeed'))

    expect(emittedEvents.map((e) => e.type)).toEqual([
      'TaskStarted',
      'MessageDelta',
      'TaskMessageDelta',
      'TaskFailed',
      'TaskStarted',
      'MessageDelta',
      'TaskMessageDelta',
      'RunCompleted',
      'TaskCompleted',
    ])
    expect(executor.executionState).toBe('idle')
    expect(executor.currentTaskId).toBeNull()
    expect(stateChanges).toEqual(['busy', 'idle', 'busy', 'idle'])
  })
})
