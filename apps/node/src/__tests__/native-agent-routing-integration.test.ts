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
  createNodeId,
  createTaskId,
} from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import type { ControlPlaneConnectionLike } from '../node-runtime/controlplane-runtime.js'
import { createControlPlaneRuntime } from '../node-runtime/controlplane-runtime.js'
import {
  createCommand,
  messageDeltaEvent,
  runCompletedEvent,
} from './helpers/native-agent-test-utils.js'

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

describe('ControlPlaneRuntime unified entry routing integration', () => {
  it('creates unified entry for native task command and runs it', async () => {
    const emittedEvents: DomainEvent[] = []
    const publishedEnvelopes: DomainEventEnvelope[] = []
    const connectionDouble = createConnectionDouble()
    const runSpy = vi.fn(async () => ({
      sessionId: 'session-test' as never,
      runId: 'run-test' as never,
      events: (async function* () {
        yield messageDeltaEvent()
        yield runCompletedEvent()
      })(),
    }))
    const createUnifiedEntryMock = vi.fn(async () =>
      createUnifiedEntry([messageDeltaEvent(), runCompletedEvent()], runSpy)
    )

    const runtime = createControlPlaneRuntime(
      createRuntimeConfig(emittedEvents, publishedEnvelopes),
      {
        createConnection: () => connectionDouble,
        createUnifiedEntry: createUnifiedEntryMock,
      }
    )

    const taskId = createTaskId('task-routing-001')
    const command = createCommand(taskId, 'review the code')
    await runtime.onCommand(command)

    expect(createUnifiedEntryMock).toHaveBeenCalledWith(command)
    expect(runSpy).toHaveBeenCalledWith({
      source: 'controlplane',
      agentId: 'test-agent',
      input: 'review the code',
      sessionId: undefined,
    })

    const emittedTypes = emittedEvents.map((e) => e.type)
    expect(emittedTypes).toContain('TaskStarted')
    expect(emittedTypes).toContain('MessageDelta')
    expect(emittedTypes).toContain('RunCompleted')
    expect(emittedTypes).toContain('TaskCompleted')
    expect(emittedTypes).not.toContain('TaskFailed')
    assertNoSyntheticRunEnvelopes(publishedEnvelopes)

    const setStateFn = vi.mocked(connectionDouble.setExecutionState)
    expect(setStateFn).toHaveBeenCalledWith('busy')
    expect(setStateFn).toHaveBeenLastCalledWith('idle')
  })

  it('throws when native runtime dependencies are missing on default unified entry path', async () => {
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
      'ControlPlaneRuntime requires nativeAgentContext, defaultGraph, and executorFactory for unified task execution'
    )

    expect(emittedEvents).toEqual([])

    const setStateFn = vi.mocked(connectionDouble.setExecutionState)
    expect(setStateFn).toHaveBeenLastCalledWith('busy')
  })
})
