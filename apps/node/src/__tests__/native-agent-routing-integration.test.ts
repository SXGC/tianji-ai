/**
 * ControlPlaneRuntime native agent routing integration tests.
 *
 * Verifies that createControlPlaneRuntime correctly routes native agent
 * commands through the real InProcessAgentRunner (not mocking the runner
 * constructor), validating the full path from runtime to agent session.
 */
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

import type { ControlPlaneConnectionLike } from '../node-runtime/controlplane-runtime.js'
import { createControlPlaneRuntime } from '../node-runtime/controlplane-runtime.js'
import {
  SESSION_ID,
  createCommand,
  createFakeContext,
  messageDeltaEvent,
  runCompletedEvent,
} from './helpers/native-agent-test-utils.js'

/**
 * Mock @tianji/agent at module level so real InProcessAgentRunner calls
 * loadAgentContextForName / createAgentSession from the mock.
 */
vi.mock('@tianji/agent', () => ({
  loadAgentContextForName: vi.fn(),
  createAgentSession: vi.fn(),
}))

/** 最小化 stub，仅满足 createControlPlaneRuntime config 所需 */
const stubDefaultGraph = {} as OrchestrationGraph
const stubExecutorFactory = (() => {
  throw new Error('not used in unit tests')
}) as unknown as AgentExecutorFactory

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let agentMock: typeof import('@tianji/agent')

beforeEach(async () => {
  vi.clearAllMocks()
  agentMock = await import('@tianji/agent')
})

/** 创建 ControlPlaneConnectionLike double，client 提供 postDomainEvents/maxSequence stub。 */
function createConnectionDouble(): ControlPlaneConnectionLike {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    setExecutionState: vi.fn(),
    client: {
      postDomainEvents: vi.fn(async () => undefined),
      maxSequence: vi.fn(async () => null),
    },
  }
}

/** 构造最小合法的 runtime config，包含统一的 emitTaskEvent 收集器。 */
function createRuntimeConfig(
  emittedEvents: DomainEvent[],
  publishedEnvelopes: DomainEventEnvelope[]
) {
  const contextRef = { current: CausalContext.root('routing-correlation') }
  const pipeline = createRuntimeEventPipeline({
    publish: (env) => publishedEnvelopes.push(env),
    counter: new SequenceCounter(),
    contextProvider: {
      getCurrent: () => contextRef.current,
      update: (next) => {
        contextRef.current = next
      },
    },
    source: { processKind: 'node', processId: 'test-node', nodeId: createNodeId('node-routing') },
    recoverer: NoopSequenceRecoverer,
  })

  return {
    baseUrl: 'http://localhost:3000',
    nodeId: createNodeId('node-routing'),
    enrollmentToken: 'tok',
    hostname: 'testhost',
    platform: 'linux',
    version: '1.0.0',
    agentList: [] as never[],
    agentConfigs: {
      'test-agent': { model: 'openai/gpt-4o-mini' },
    },
    nativeAgentContext: createFakeContext(),
    defaultGraph: stubDefaultGraph,
    executorFactory: stubExecutorFactory,
    enterCorrelation: async <T>(_correlationId: string, fn: () => Promise<T>) => fn(),
    emitTaskEvent: async (ev: DomainEvent) => {
      emittedEvents.push(ev)
      await pipeline.emitEvent(ev)
    },
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

describe('ControlPlaneRuntime native agent routing integration', () => {
  it('routes native agent command through real InProcessAgentRunner', async () => {
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

    const emittedEvents: DomainEvent[] = []
    const publishedEnvelopes: DomainEventEnvelope[] = []
    const connectionDouble = createConnectionDouble()

    const runtime = createControlPlaneRuntime(
      createRuntimeConfig(emittedEvents, publishedEnvelopes),
      {
        createConnection: () => connectionDouble,
      }
    )

    const taskId = createTaskId('task-routing-001')
    await runtime.onCommand(createCommand(taskId, 'review the code'))

    // loadAgentContextForName was called with the correct agentId
    expect(agentMock.loadAgentContextForName).toHaveBeenCalledWith('test-agent', expect.any(Object))

    // createAgentSession was called
    expect(agentMock.createAgentSession).toHaveBeenCalled()

    const emittedTypes = emittedEvents.map((e) => e.type)
    expect(emittedTypes).toContain('TaskStarted')
    expect(emittedTypes).toContain('MessageDelta')
    expect(emittedTypes).toContain('RunCompleted')
    expect(emittedTypes).toContain('TaskCompleted')
    expect(emittedTypes).not.toContain('TaskFailed')
    assertNoSyntheticRunEnvelopes(publishedEnvelopes)

    // connectionDouble.setExecutionState was called with 'busy' then last called with 'idle'
    const setStateFn = vi.mocked(connectionDouble.setExecutionState)
    expect(setStateFn).toHaveBeenCalledWith('busy')
    expect(setStateFn).toHaveBeenLastCalledWith('idle')
  })

  it('propagates agent session failure and recovers to idle', async () => {
    vi.mocked(agentMock.loadAgentContextForName).mockRejectedValue(new Error('soul file missing'))

    const emittedEvents: DomainEvent[] = []
    const publishedEnvelopes: DomainEventEnvelope[] = []
    const connectionDouble = createConnectionDouble()

    const runtime = createControlPlaneRuntime(
      createRuntimeConfig(emittedEvents, publishedEnvelopes),
      {
        createConnection: () => connectionDouble,
      }
    )

    const taskId = createTaskId('task-routing-002')
    await expect(runtime.onCommand(createCommand(taskId, 'fail'))).rejects.toThrow(
      'soul file missing'
    )

    // lifecycle events: TaskStarted + TaskFailed
    const lifecycleTypes = emittedEvents.map((e) => e.type)
    expect(lifecycleTypes).toContain('TaskStarted')
    expect(lifecycleTypes).toContain('TaskFailed')

    // connectionDouble.setExecutionState last called with 'idle' (recovery)
    const setStateFn = vi.mocked(connectionDouble.setExecutionState)
    expect(setStateFn).toHaveBeenLastCalledWith('idle')
  })
})
