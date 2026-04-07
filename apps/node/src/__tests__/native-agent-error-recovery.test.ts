import { type RuntimeEvent, createNodeId, createTaskId } from '@tianji/shared'
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

// --- setup ---

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let agentMock: typeof import('@tianji/agent')

beforeEach(async () => {
  vi.clearAllMocks()
  agentMock = await import('@tianji/agent')
})

// --- tests ---

describe('TaskExecutor error recovery and resource cleanup', () => {
  it('recovers to idle when connect fails with agent config not found', async () => {
    vi.mocked(agentMock.loadAgentContextForName).mockRejectedValue(
      new Error('agent config not found')
    )

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
        })
      },
      openEventStream: async () => writer,
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

    // Events written: task.started + task.failed (with error message)
    expect(lines).toHaveLength(2)
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(parsed[0]).toMatchObject({ kind: 'lifecycle', sequence: 1, type: 'task.started' })
    expect(parsed[1]).toMatchObject({
      kind: 'lifecycle',
      sequence: 2,
      type: 'task.failed',
      error: 'agent config not found',
    })
  })

  it('cleans up session when query fails mid-stream', async () => {
    const abortFn = vi.fn()

    vi.mocked(agentMock.loadAgentContextForName).mockResolvedValue(createFakeContext())
    vi.mocked(agentMock.createAgentSession).mockReturnValue({
      sessionId: SESSION_ID,
      query: async function* () {
        yield messageDeltaEvent()
        throw new Error('provider rate limited')
      },
      abort: abortFn,
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
        })
      },
      openEventStream: async () => writer,
    })

    const taskId = createTaskId('task-err-002')
    await expect(executor.execute(createCommand(taskId, 'fail mid-stream'))).rejects.toThrow(
      'provider rate limited'
    )

    // Events: task.started -> message.delta -> task.failed
    expect(lines).toHaveLength(3)
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(parsed[0]).toMatchObject({ kind: 'lifecycle', sequence: 1, type: 'task.started' })
    expect(parsed[1]).toMatchObject({ kind: 'agent', sequence: 2 })
    expect((parsed[1] as { event: RuntimeEvent }).event.type).toBe('message.delta')
    expect(parsed[2]).toMatchObject({
      kind: 'lifecycle',
      sequence: 3,
      type: 'task.failed',
      error: 'provider rate limited',
    })

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
      query: async function* () {
        yield messageDeltaEvent()
        yield runCompletedEvent()
      },
      abort: abortFn,
    })

    const stateChanges: string[] = []
    const baseContext = createFakeContext()

    const failWriter = createNdjsonWriterStub()
    const successWriter = createNdjsonWriterStub()
    let callCount = 0

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-test'),
      onExecutionStateChange: (s) => stateChanges.push(s),
      createRunner: async (cmd) => {
        return new InProcessAgentRunner({
          agentId: cmd.payload.agentId,
          nativeAgentContext: baseContext,
        })
      },
      openEventStream: async () => {
        callCount += 1
        return callCount === 1 ? failWriter.writer : successWriter.writer
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

    // Verify second run produced correct events
    expect(successWriter.lines).toHaveLength(4)
    const parsed = successWriter.lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(parsed[0]).toMatchObject({ kind: 'lifecycle', sequence: 1, type: 'task.started' })
    expect((parsed[1] as { event: RuntimeEvent }).event.type).toBe('message.delta')
    expect((parsed[2] as { event: RuntimeEvent }).event.type).toBe('run.completed')
    expect(parsed[3]).toMatchObject({ kind: 'lifecycle', sequence: 4, type: 'task.completed' })

    // Executor is idle after both calls
    expect(executor.executionState).toBe('idle')
    expect(executor.currentTaskId).toBeNull()

    // State transitions: busy->idle (fail), busy->idle (success)
    expect(stateChanges).toEqual(['busy', 'idle', 'busy', 'idle'])
  })
})
