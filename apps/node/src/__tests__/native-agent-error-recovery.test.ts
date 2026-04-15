import type { AgentExecutorFactory, OrchestrationGraph } from '@tianji/agent'
import {
  type DomainEvent,
  type DomainEventEnvelope,
  TianjiError,
  createNodeId,
  createTaskId,
} from '@tianji/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { InProcessAgentRunner } from '../acp/in-process-runner.js'
import { TaskExecutor } from '../task/task-executor.js'
import {
  SESSION_ID,
  createCommand,
  createFakeContext,
  messageDeltaEvent,
  runCompletedEvent,
} from './helpers/native-agent-test-utils.js'

/**
 * Mock @tianji/agent module at the top level.
 * Provides controllable createAgentSession / loadAgentContextForName stubs
 * for testing error recovery and resource cleanup scenarios.
 */
vi.mock('@tianji/agent', () => ({
  loadAgentContextForName: vi.fn(),
  createAgentSession: vi.fn(),
}))

/** 最小化 stub，仅满足 InProcessAgentRunner 构造签名所需 */
const stubDefaultGraph = {} as OrchestrationGraph
const stubExecutorFactory = (() => {
  throw new Error('not used in unit tests')
}) as unknown as AgentExecutorFactory

// --- setup ---

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let agentMock: typeof import('@tianji/agent')

beforeEach(async () => {
  vi.clearAllMocks()
  agentMock = await import('@tianji/agent')
})

// --- tests ---

describe('TaskExecutor error recovery and resource cleanup', () => {
  it('recovers to idle when connect fails, emits TaskStarted then TaskFailed', async () => {
    vi.mocked(agentMock.loadAgentContextForName).mockRejectedValue(
      new Error('agent config not found')
    )

    const stateChanges: string[] = []
    const emittedEvents: DomainEvent[] = []
    const baseContext = createFakeContext()

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: (s) => stateChanges.push(s),
      emitEvent: (ev) => emittedEvents.push(ev),
      publishEnvelope: vi.fn(),
      createRunner: async (cmd) => {
        return new InProcessAgentRunner({
          agentId: cmd.payload.agentId,
          nativeAgentContext: baseContext,
          defaultGraph: stubDefaultGraph,
          executorFactory: stubExecutorFactory,
        })
      },
    })

    const taskId = createTaskId('task-err-001')
    await expect(executor.execute(createCommand(taskId, 'fail at connect'))).rejects.toThrow(
      'agent config not found'
    )

    // State transitions: busy -> idle
    expect(stateChanges).toEqual(['busy', 'idle'])

    // Executor returns to idle with null currentTaskId
    expect(executor.executionState).toBe('idle')
    expect(executor.currentTaskId).toBeNull()

    // lifecycle events: TaskStarted + TaskFailed
    const lifecycleTypes = emittedEvents.map((e) => e.type)
    expect(lifecycleTypes).toContain('TaskStarted')
    expect(lifecycleTypes).toContain('TaskFailed')
    expect(lifecycleTypes).not.toContain('TaskCompleted')

    // TaskFailed.error 携带原始错误消息
    const failedEvent = emittedEvents.find(
      (e): e is Extract<DomainEvent, { type: 'TaskFailed' }> => e.type === 'TaskFailed'
    )
    expect(failedEvent?.error).toBeInstanceOf(TianjiError)
    expect(failedEvent?.error.message).toBe('agent config not found')
  })

  it('cleans up session when query fails mid-stream', async () => {
    const abortFn = vi.fn()

    vi.mocked(agentMock.loadAgentContextForName).mockResolvedValue(createFakeContext())
    vi.mocked(agentMock.createAgentSession).mockReturnValue({
      sessionId: SESSION_ID,
      queryWithGraph: async function* () {
        yield messageDeltaEvent()
        throw new Error('provider rate limited')
      },
      abort: abortFn,
    })

    const stateChanges: string[] = []
    const emittedEvents: DomainEvent[] = []
    const publishedEnvelopes: DomainEventEnvelope[] = []
    const baseContext = createFakeContext()

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: (s) => stateChanges.push(s),
      emitEvent: (ev) => emittedEvents.push(ev),
      publishEnvelope: (env) => publishedEnvelopes.push(env),
      createRunner: async (cmd) => {
        return new InProcessAgentRunner({
          agentId: cmd.payload.agentId,
          nativeAgentContext: baseContext,
          defaultGraph: stubDefaultGraph,
          executorFactory: stubExecutorFactory,
        })
      },
    })

    const taskId = createTaskId('task-err-002')
    await expect(executor.execute(createCommand(taskId, 'fail mid-stream'))).rejects.toThrow(
      'provider rate limited'
    )

    // lifecycle: TaskStarted + TaskFailed
    const lifecycleTypes = emittedEvents.map((e) => e.type)
    expect(lifecycleTypes).toContain('TaskStarted')
    expect(lifecycleTypes).toContain('TaskFailed')

    // agent envelope published before throw
    expect(publishedEnvelopes).toHaveLength(1)
    expect(publishedEnvelopes[0]?.payload.type).toBe('MessageDelta')

    // session.abort() was called during runner.disconnect()
    expect(abortFn).toHaveBeenCalled()

    // Executor returns to idle
    expect(stateChanges).toEqual(['busy', 'idle'])
    expect(executor.executionState).toBe('idle')
    expect(executor.currentTaskId).toBeNull()
  })

  it('executor is reusable after a failure', async () => {
    const abortFn = vi.fn()

    // First call: connect fails
    vi.mocked(agentMock.loadAgentContextForName).mockRejectedValueOnce(
      new Error('transient failure')
    )

    // Second call: succeeds
    vi.mocked(agentMock.loadAgentContextForName).mockResolvedValueOnce(createFakeContext())
    vi.mocked(agentMock.createAgentSession).mockReturnValue({
      sessionId: SESSION_ID,
      queryWithGraph: async function* () {
        yield messageDeltaEvent()
        yield runCompletedEvent()
      },
      abort: abortFn,
    })

    const stateChanges: string[] = []
    const emittedEvents: DomainEvent[] = []
    const publishedEnvelopes: DomainEventEnvelope[] = []
    const baseContext = createFakeContext()

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: (s) => stateChanges.push(s),
      emitEvent: (ev) => emittedEvents.push(ev),
      publishEnvelope: (env) => publishedEnvelopes.push(env),
      createRunner: async (cmd) => {
        return new InProcessAgentRunner({
          agentId: cmd.payload.agentId,
          nativeAgentContext: baseContext,
          defaultGraph: stubDefaultGraph,
          executorFactory: stubExecutorFactory,
        })
      },
    })

    // First execute rejects
    const taskId1 = createTaskId('task-err-003a')
    await expect(executor.execute(createCommand(taskId1, 'will fail'))).rejects.toThrow(
      'transient failure'
    )

    // Second execute succeeds
    const taskId2 = createTaskId('task-err-003b')
    await executor.execute(createCommand(taskId2, 'will succeed'))

    // lifecycle events: TaskStarted + TaskFailed (first) + TaskStarted + TaskCompleted (second)
    const lifecycleTypes = emittedEvents.map((e) => e.type)
    expect(lifecycleTypes).toEqual(['TaskStarted', 'TaskFailed', 'TaskStarted', 'TaskCompleted'])

    // agent envelopes: MessageDelta + RunCompleted (from second run only)
    expect(publishedEnvelopes.map((e) => e.payload.type)).toEqual(['MessageDelta', 'RunCompleted'])

    // Executor is idle after both calls
    expect(executor.executionState).toBe('idle')
    expect(executor.currentTaskId).toBeNull()

    // State transitions: busy->idle (fail), busy->idle (success)
    expect(stateChanges).toEqual(['busy', 'idle', 'busy', 'idle'])
  })
})
