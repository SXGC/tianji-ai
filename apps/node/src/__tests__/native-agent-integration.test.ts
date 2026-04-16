import type { AgentExecutorFactory, OrchestrationGraph } from '@tianji/agent'
import {
  CausalContext,
  NoopSequenceRecoverer,
  SequenceCounter,
  createRuntimeEventPipeline,
} from '@tianji/runtime'
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

describe('TaskExecutor + InProcessAgentRunner integration', () => {
  it('emits TaskStarted/TaskCompleted and runner events on success', async () => {
    const events: DomainEvent[] = [messageDeltaEvent(), runCompletedEvent()]
    vi.mocked(agentMock.loadAgentContextForName).mockResolvedValue(createFakeContext())
    vi.mocked(agentMock.createAgentSession).mockResolvedValue({
      sessionId: SESSION_ID,
      queryWithGraph: async function* () {
        for (const e of events) yield e
      },
      abort: vi.fn(),
      close: vi.fn(),
    })

    const stateChanges: string[] = []
    const emittedEvents: DomainEvent[] = []
    const { publishedEnvelopes, emitEvent } = createEnvelopeCollector()
    const baseContext = createFakeContext()

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: (s) => stateChanges.push(s),
      enterCorrelation: async (_correlationId, fn) => fn(),
      emitEvent: async (ev) => {
        emittedEvents.push(ev)
        await emitEvent(ev)
      },
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
    vi.mocked(agentMock.loadAgentContextForName).mockResolvedValue(createFakeContext())
    vi.mocked(agentMock.createAgentSession).mockResolvedValue({
      sessionId: SESSION_ID,
      queryWithGraph: async function* () {
        for (const e of events) yield e
      },
      abort: vi.fn(),
      close: vi.fn(),
    })

    const emittedEvents: DomainEvent[] = []
    const baseContext = createFakeContext()

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: () => undefined,
      enterCorrelation: async (_correlationId, fn) => fn(),
      emitEvent: (event) => emittedEvents.push(event),
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
    expect(emittedEvents.map((e) => e.type)).toEqual([
      'TaskStarted',
      'ToolStarted',
      'ToolCompleted',
      'RunCompleted',
      'TaskCompleted',
    ])
  })

  it('deduplicates repeated RunCompleted events through the full pipeline', async () => {
    const events: DomainEvent[] = [runCompletedEvent(), runCompletedEvent(), runCompletedEvent()]
    vi.mocked(agentMock.loadAgentContextForName).mockResolvedValue(createFakeContext())
    vi.mocked(agentMock.createAgentSession).mockResolvedValue({
      sessionId: SESSION_ID,
      queryWithGraph: async function* () {
        for (const e of events) yield e
      },
      abort: vi.fn(),
      close: vi.fn(),
    })

    const emittedEvents: DomainEvent[] = []
    const baseContext = createFakeContext()

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: () => undefined,
      enterCorrelation: async (_correlationId, fn) => fn(),
      emitEvent: (event) => emittedEvents.push(event),
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
    expect(emittedEvents.map((event) => event.type)).toEqual([
      'TaskStarted',
      'RunCompleted',
      'TaskCompleted',
    ])
  })
})
