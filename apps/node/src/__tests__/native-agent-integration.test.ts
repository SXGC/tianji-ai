import type { AgentExecutorFactory, OrchestrationGraph } from '@tianji/agent'
import { type DomainEvent, createNodeId, createTaskId } from '@tianji/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { InProcessAgentRunner } from '../acp/in-process-runner.js'
import { TaskExecutor } from '../task/task-executor.js'
import {
  SESSION_ID,
  createCommand,
  createFakeContext,
  createNdjsonWriterStub,
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
  it('produces correct NDJSON event sequence for a successful run', async () => {
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
    const { lines, writer } = createNdjsonWriterStub()
    const baseContext = createFakeContext()

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: (s) => stateChanges.push(s),
      createRunner: async (cmd) => {
        return new InProcessAgentRunner({
          agentId: cmd.payload.agentId,
          nativeAgentContext: baseContext,
          defaultGraph: stubDefaultGraph,
          executorFactory: stubExecutorFactory,
        })
      },
      openEventStream: async () => writer,
    })

    expect(executor.executionState).toBe('idle')

    const taskId = createTaskId('task-001')
    await executor.execute(createCommand(taskId, 'do something'))

    // State transitions: busy -> idle
    expect(stateChanges).toEqual(['busy', 'idle'])

    // Executor returns to idle with null currentTaskId
    expect(executor.executionState).toBe('idle')
    expect(executor.currentTaskId).toBeNull()

    // NDJSON output: task.started(1) -> MessageDelta(2) -> RunCompleted(3) -> task.completed(4)
    expect(lines).toHaveLength(4)

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)

    expect(parsed[0]).toMatchObject({ kind: 'lifecycle', sequence: 1, type: 'task.started' })
    expect(parsed[1]).toMatchObject({ kind: 'agent', sequence: 2 })
    expect((parsed[1] as { event: DomainEvent }).event.type).toBe('MessageDelta')
    expect(parsed[2]).toMatchObject({ kind: 'agent', sequence: 3 })
    expect((parsed[2] as { event: DomainEvent }).event.type).toBe('RunCompleted')
    expect(parsed[3]).toMatchObject({ kind: 'lifecycle', sequence: 4, type: 'task.completed' })

    // Sequences are contiguous with no gaps
    const sequences = parsed.map((p) => p.sequence as number)
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBe(sequences[i - 1]! + 1)
    }
  })

  it('serializes tool events in correct NDJSON format', async () => {
    const events: DomainEvent[] = [toolStartedEvent(), toolCompletedEvent(), runCompletedEvent()]
    vi.mocked(agentMock.loadAgentContextForName).mockResolvedValue(createFakeContext())
    vi.mocked(agentMock.createAgentSession).mockReturnValue({
      sessionId: SESSION_ID,
      queryWithGraph: async function* () {
        for (const e of events) yield e
      },
      abort: vi.fn(),
    })

    const { lines, writer } = createNdjsonWriterStub()
    const baseContext = createFakeContext()

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: () => undefined,
      createRunner: async (cmd) => {
        return new InProcessAgentRunner({
          agentId: cmd.payload.agentId,
          nativeAgentContext: baseContext,
          defaultGraph: stubDefaultGraph,
          executorFactory: stubExecutorFactory,
        })
      },
      openEventStream: async () => writer,
    })

    await executor.execute(createCommand(createTaskId('task-002'), 'use tools'))

    // 5 total events: started + ToolStarted + ToolCompleted + RunCompleted + completed
    expect(lines).toHaveLength(5)

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)

    expect(parsed[0]).toMatchObject({ kind: 'lifecycle', sequence: 1, type: 'task.started' })
    expect(parsed[1]).toMatchObject({ kind: 'agent', sequence: 2 })
    expect((parsed[1] as { event: DomainEvent }).event.type).toBe('ToolStarted')
    expect(parsed[2]).toMatchObject({ kind: 'agent', sequence: 3 })
    expect((parsed[2] as { event: DomainEvent }).event.type).toBe('ToolCompleted')
    expect(parsed[3]).toMatchObject({ kind: 'agent', sequence: 4 })
    expect((parsed[3] as { event: DomainEvent }).event.type).toBe('RunCompleted')
    expect(parsed[4]).toMatchObject({ kind: 'lifecycle', sequence: 5, type: 'task.completed' })
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

    const { lines, writer } = createNdjsonWriterStub()
    const baseContext = createFakeContext()

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: () => undefined,
      createRunner: async (cmd) => {
        return new InProcessAgentRunner({
          agentId: cmd.payload.agentId,
          nativeAgentContext: baseContext,
          defaultGraph: stubDefaultGraph,
          executorFactory: stubExecutorFactory,
        })
      },
      openEventStream: async () => writer,
    })

    await executor.execute(createCommand(createTaskId('task-003'), 'duplicate test'))

    // Only 3 events: task.started + 1x RunCompleted + task.completed (duplicates stripped)
    expect(lines).toHaveLength(3)

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)

    expect(parsed[0]).toMatchObject({ kind: 'lifecycle', sequence: 1, type: 'task.started' })
    expect(parsed[1]).toMatchObject({ kind: 'agent', sequence: 2 })
    expect((parsed[1] as { event: DomainEvent }).event.type).toBe('RunCompleted')
    expect(parsed[2]).toMatchObject({ kind: 'lifecycle', sequence: 3, type: 'task.completed' })
  })
})
