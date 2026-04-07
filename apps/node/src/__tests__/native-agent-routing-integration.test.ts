/**
 * ControlPlaneRuntime native agent routing integration tests.
 *
 * Verifies that createControlPlaneRuntime correctly routes native agent
 * commands through the real InProcessAgentRunner (not mocking the runner
 * constructor), validating the full path from runtime to agent session.
 */
import { type RuntimeEvent, createNodeId, createTaskId } from '@tianji/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ControlPlaneConnectionLike } from '../node-runtime/controlplane-runtime.js'
import { createControlPlaneRuntime } from '../node-runtime/controlplane-runtime.js'
import {
  SESSION_ID,
  createCommand,
  createFakeContext,
  createNdjsonWriterStub,
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

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let agentMock: typeof import('@tianji/agent')

beforeEach(async () => {
  vi.clearAllMocks()
  agentMock = await import('@tianji/agent')
})

/**
 * Creates a ControlPlaneConnectionLike double with an event stream backed
 * by the provided NDJSON writer stub.
 */
function createConnectionDouble(
  writerStub: ReturnType<typeof createNdjsonWriterStub>['writer']
): ControlPlaneConnectionLike {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    setExecutionState: vi.fn(),
    client: {
      openEventStream: vi.fn(async () => writerStub),
    },
  }
}

describe('ControlPlaneRuntime native agent routing integration', () => {
  it('routes native agent command through real InProcessAgentRunner', async () => {
    const events: RuntimeEvent[] = [messageDeltaEvent(), runCompletedEvent()]
    vi.mocked(agentMock.loadAgentContextForName).mockResolvedValue(createFakeContext())
    vi.mocked(agentMock.createAgentSession).mockReturnValue({
      sessionId: SESSION_ID,
      query: async function* () {
        for (const e of events) yield e
      },
      abort: vi.fn(),
    })

    const { lines, writer } = createNdjsonWriterStub()
    const connectionDouble = createConnectionDouble(writer)

    const runtime = createControlPlaneRuntime(
      {
        baseUrl: 'http://localhost:3000',
        nodeId: createNodeId('node-routing'),
        enrollmentToken: 'tok',
        hostname: 'testhost',
        platform: 'linux',
        version: '1.0.0',
        agentList: [],
        agentConfigs: {
          'test-agent': { model: 'openai/gpt-4o-mini' },
        },
        nativeAgentContext: createFakeContext(),
      },
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

    // Events written include task.started and task.completed
    expect(lines).toHaveLength(4)
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(parsed[0]).toMatchObject({ kind: 'lifecycle', sequence: 1, type: 'task.started' })
    expect(parsed[parsed.length - 1]).toMatchObject({
      kind: 'lifecycle',
      sequence: 4,
      type: 'task.completed',
    })

    // connectionDouble.setExecutionState was called with 'busy' then last called with 'idle'
    const setStateFn = vi.mocked(connectionDouble.setExecutionState)
    expect(setStateFn).toHaveBeenCalledWith('busy')
    expect(setStateFn).toHaveBeenLastCalledWith('idle')
  })

  it('propagates agent session failure and recovers to idle', async () => {
    vi.mocked(agentMock.loadAgentContextForName).mockRejectedValue(new Error('soul file missing'))

    const { lines, writer } = createNdjsonWriterStub()
    const connectionDouble = createConnectionDouble(writer)

    const runtime = createControlPlaneRuntime(
      {
        baseUrl: 'http://localhost:3000',
        nodeId: createNodeId('node-routing'),
        enrollmentToken: 'tok',
        hostname: 'testhost',
        platform: 'linux',
        version: '1.0.0',
        agentList: [],
        agentConfigs: {
          'test-agent': { model: 'openai/gpt-4o-mini' },
        },
        nativeAgentContext: createFakeContext(),
      },
      {
        createConnection: () => connectionDouble,
      }
    )

    const taskId = createTaskId('task-routing-002')
    await expect(runtime.onCommand(createCommand(taskId, 'fail'))).rejects.toThrow(
      'soul file missing'
    )

    // Events written include task.started and task.failed
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(parsed[0]).toMatchObject({ kind: 'lifecycle', type: 'task.started' })
    expect(parsed[parsed.length - 1]).toMatchObject({
      kind: 'lifecycle',
      type: 'task.failed',
      error: 'soul file missing',
    })

    // connectionDouble.setExecutionState last called with 'idle' (recovery)
    const setStateFn = vi.mocked(connectionDouble.setExecutionState)
    expect(setStateFn).toHaveBeenLastCalledWith('idle')
  })
})
