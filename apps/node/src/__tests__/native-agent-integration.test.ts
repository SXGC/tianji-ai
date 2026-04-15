import type { AgentExecutorFactory, OrchestrationGraph } from '@tianji/agent'
import {
  type DomainEvent,
  type DomainEventEnvelope,
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
  toolCompletedEvent,
  toolStartedEvent,
} from './helpers/native-agent-test-utils.js'

/**
 * Mock @tianji/agent module at the top level.
 * Provides controllable createAgentSession / loadAgentContextForName stubs
 * so real InProcessAgentRunner and TaskExecutor code runs against fake sessions.
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

describe('TaskExecutor + InProcessAgentRunner integration', () => {
  it('emits TaskStarted/TaskCompleted and publishes agent envelopes on success', async () => {
    const events: DomainEvent[] = [messageDeltaEvent(), runCompletedEvent()]
    vi.mocked(agentMock.loadAgentContextForName).mockResolvedValue(createFakeContext())
    vi.mocked(agentMock.createAgentSession).mockReturnValue({
      sessionId: SESSION_ID,
      queryWithGraph: async function* () {
        for (const e of events) yield e
      },
      abort: vi.fn(),
    })

    const stateChanges: string[] = []
    const emittedEvents: DomainEvent[] = []
    const publishedEnvelopes: DomainEventEnvelope[] = []
    const baseContext = createFakeContext()

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: (s) => stateChanges.push(s),
      enterCorrelation: async (_correlationId, fn) => fn(),
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

    expect(executor.executionState).toBe('idle')

    const taskId = createTaskId('task-001')
    await executor.execute(createCommand(taskId, 'do something'))

    // State transitions: busy -> idle
    expect(stateChanges).toEqual(['busy', 'idle'])

    // Executor returns to idle with null currentTaskId
    expect(executor.executionState).toBe('idle')
    expect(executor.currentTaskId).toBeNull()

    // lifecycle events via emitEvent
    const lifecycleTypes = emittedEvents.map((e) => e.type)
    expect(lifecycleTypes).toContain('TaskStarted')
    expect(lifecycleTypes).toContain('TaskCompleted')
    expect(lifecycleTypes).not.toContain('TaskFailed')

    // agent envelopes via publishEnvelope (MessageDelta + RunCompleted)
    expect(publishedEnvelopes).toHaveLength(2)
    expect(publishedEnvelopes[0]?.payload.type).toBe('MessageDelta')
    expect(publishedEnvelopes[1]?.payload.type).toBe('RunCompleted')
  })

  it('publishes tool events as envelopes', async () => {
    const events: DomainEvent[] = [toolStartedEvent(), toolCompletedEvent(), runCompletedEvent()]
    vi.mocked(agentMock.loadAgentContextForName).mockResolvedValue(createFakeContext())
    vi.mocked(agentMock.createAgentSession).mockReturnValue({
      sessionId: SESSION_ID,
      queryWithGraph: async function* () {
        for (const e of events) yield e
      },
      abort: vi.fn(),
    })

    const publishedEnvelopes: DomainEventEnvelope[] = []
    const baseContext = createFakeContext()

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: () => undefined,
      enterCorrelation: async (_correlationId, fn) => fn(),
      emitEvent: vi.fn(),
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

    await executor.execute(createCommand(createTaskId('task-002'), 'use tools'))

    // ToolStarted + ToolCompleted + RunCompleted
    expect(publishedEnvelopes).toHaveLength(3)
    expect(publishedEnvelopes.map((e) => e.payload.type)).toEqual([
      'ToolStarted',
      'ToolCompleted',
      'RunCompleted',
    ])
  })

  it('deduplicates repeated RunCompleted events through the full pipeline', async () => {
    const events: DomainEvent[] = [runCompletedEvent(), runCompletedEvent(), runCompletedEvent()]
    vi.mocked(agentMock.loadAgentContextForName).mockResolvedValue(createFakeContext())
    vi.mocked(agentMock.createAgentSession).mockReturnValue({
      sessionId: SESSION_ID,
      queryWithGraph: async function* () {
        for (const e of events) yield e
      },
      abort: vi.fn(),
    })

    const publishedEnvelopes: DomainEventEnvelope[] = []
    const baseContext = createFakeContext()

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: () => undefined,
      enterCorrelation: async (_correlationId, fn) => fn(),
      emitEvent: vi.fn(),
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

    await executor.execute(createCommand(createTaskId('task-003'), 'duplicate test'))

    // InProcessAgentRunner 对 RunCompleted 去重：只 yield 第一个
    expect(publishedEnvelopes).toHaveLength(1)
    expect(publishedEnvelopes[0]?.payload.type).toBe('RunCompleted')
  })
})
