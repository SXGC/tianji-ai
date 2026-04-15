import {
  type Command,
  type DomainEvent,
  type DomainEventEnvelope,
  TianjiError,
  ToolError,
  createNodeId,
  createTaskId,
} from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import type { IAgentRunner } from '../../acp/index.js'
import { createCliLogger } from '../../logger.js'
import type { TaskExecutorConfig } from '../task-executor.js'

/** 将裸 DomainEvent 包装为最小化 DomainEventEnvelope，专用于测试。 */
function wrap(event: DomainEvent): DomainEventEnvelope {
  const runId = 'runId' in event ? String(event.runId) : 'test'
  return {
    eventId: `test_${event.type}`,
    type: event.type,
    occurredAt: new Date().toISOString(),
    correlationId: runId,
    causationId: null,
    sequence: 0,
    aggregateType: 'Run',
    aggregateId: runId,
    source: { processKind: 'node', processId: 'test' },
    payload: event,
  }
}

function createCommand(taskId: ReturnType<typeof createTaskId>, goal: string): Command {
  return {
    commandId: `command-${taskId}` as never,
    nodeId: createNodeId('node-001'),
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

function createRunnerStub(): IAgentRunner {
  return {
    agentId: 'default',
    connect: async () => undefined,
    disconnect: async () => undefined,
    async *query() {
      yield wrap({
        type: 'RunStarted',
        runId: 'run-test' as never,
        sessionId: 'session-test' as never,
        triggerType: 'new',
        timestamp: Date.now(),
      })
      yield wrap({
        type: 'RunCompleted',
        runId: 'run-test' as never,
        sessionId: 'session-test' as never,
        triggerType: 'new',
        timestamp: Date.now(),
      })
    },
  }
}

/** 构造最小化 TaskExecutorConfig，emitEvent/publishEnvelope 默认为 vi.fn()。 */
function makeConfig(overrides: Partial<TaskExecutorConfig> = {}): TaskExecutorConfig {
  return {
    nodeId: createNodeId('node-001'),
    onExecutionStateChange: () => undefined,
    emitEvent: vi.fn(),
    publishEnvelope: vi.fn(),
    createRunner: async () => {
      throw new Error('not implemented')
    },
    ...overrides,
  }
}

describe('TaskExecutorConfig', () => {
  it('should define required fields', () => {
    const config: TaskExecutorConfig = makeConfig()
    expect(config.nodeId).toBe(createNodeId('node-001'))
  })

  it('should expose idle execution state by default', async () => {
    const module = await import('../task-executor.js')
    const executor = new module.TaskExecutor(makeConfig())

    expect(executor.executionState).toBe('idle')
    expect(executor.currentTaskId).toBeNull()
  })

  it('should reject starting a second task while busy', async () => {
    const module = await import('../task-executor.js')
    const taskId = createTaskId('task-001')

    const executor = new module.TaskExecutor(
      makeConfig({ createRunner: async () => createRunnerStub() })
    )

    const first = executor.execute(createCommand(taskId, 'first'))

    await expect(
      executor.execute(createCommand(createTaskId('task-002'), 'second'))
    ).rejects.toThrow(/already executing/i)

    await first
  })

  it('writes task processing logs with expected levels', async () => {
    const module = await import('../task-executor.js')
    const written: Array<{ level: string; message: string; data?: Record<string, unknown> }> = []
    const logger = createCliLogger({
      sink: {
        async write(entry) {
          written.push({
            level: entry.level,
            message: entry.message,
            data: entry.data,
          })
        },
      },
    })

    const executor = new module.TaskExecutor(
      makeConfig({ logger, createRunner: async () => createRunnerStub() })
    )

    await executor.execute(createCommand(createTaskId('task-001'), 'first'))

    expect(
      written.some(
        (entry) => entry.level === 'info' && entry.message === 'Daemon started processing task'
      )
    ).toBe(true)
    expect(
      written.some(
        (entry) => entry.level === 'debug' && entry.message === 'Preparing task execution'
      )
    ).toBe(true)
    expect(
      written.some((entry) => entry.level === 'info' && entry.message === 'Run turn summary')
    ).toBe(true)
  })

  it('emits TaskStarted and TaskCompleted lifecycle events on success', async () => {
    const module = await import('../task-executor.js')
    const emitEvent = vi.fn()

    const executor = new module.TaskExecutor(
      makeConfig({ emitEvent, createRunner: async () => createRunnerStub() })
    )

    await executor.execute(createCommand(createTaskId('task-001'), 'success'))

    const emittedTypes = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e.type)
    expect(emittedTypes).toContain('TaskStarted')
    expect(emittedTypes).toContain('TaskCompleted')
    expect(emittedTypes).not.toContain('TaskFailed')
  })

  it('emits TaskStarted then TaskFailed when runner query throws', async () => {
    const module = await import('../task-executor.js')
    const emitEvent = vi.fn()
    const failure = new Error('runner exploded')

    const executor = new module.TaskExecutor(
      makeConfig({
        emitEvent,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield undefined as never
            throw failure
          },
        }),
      })
    )

    await expect(executor.execute(createCommand(createTaskId('task-001'), 'boom'))).rejects.toThrow(
      'runner exploded'
    )

    const emittedTypes = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e.type)
    expect(emittedTypes[0]).toBe('TaskStarted')
    expect(emittedTypes[emittedTypes.length - 1]).toBe('TaskFailed')

    // TaskFailed.error 必须携带原始错误消息
    const failedEvent = emitEvent.mock.calls.find(
      ([e]: [DomainEvent]) => e.type === 'TaskFailed'
    )?.[0] as Extract<DomainEvent, { type: 'TaskFailed' }> | undefined
    expect(failedEvent?.error).toBeInstanceOf(TianjiError)
    expect(failedEvent?.error.message).toBe('runner exploded')
  })

  it('emits TaskFailed when runner ends without terminal event', async () => {
    const module = await import('../task-executor.js')
    const emitEvent = vi.fn()

    const executor = new module.TaskExecutor(
      makeConfig({
        emitEvent,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield wrap({
              type: 'RunStarted',
              runId: 'run-test' as never,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: Date.now(),
            })
          },
        }),
      })
    )

    await expect(
      executor.execute(createCommand(createTaskId('task-001'), 'missing terminal event'))
    ).rejects.toThrow('Agent run ended without a terminal event')

    const emittedTypes = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e.type)
    expect(emittedTypes).toContain('TaskStarted')
    expect(emittedTypes).toContain('TaskFailed')
    expect(emittedTypes).not.toContain('TaskCompleted')
  })

  it('publishes agent envelopes to bus via publishEnvelope', async () => {
    const module = await import('../task-executor.js')
    const publishEnvelope = vi.fn()

    const executor = new module.TaskExecutor(
      makeConfig({ publishEnvelope, createRunner: async () => createRunnerStub() })
    )

    await executor.execute(createCommand(createTaskId('task-001'), 'envelopes'))

    // createRunnerStub yields RunStarted + RunCompleted
    expect(publishEnvelope).toHaveBeenCalledTimes(2)
    const types = (publishEnvelope.mock.calls as Array<[DomainEventEnvelope]>).map(
      ([env]) => env.payload.type
    )
    expect(types).toContain('RunStarted')
    expect(types).toContain('RunCompleted')
  })

  it('logs message.completed, tool.completed, and tool.failed events', async () => {
    const module = await import('../task-executor.js')
    const written: Array<{ level: string; message: string; data?: Record<string, unknown> }> = []
    const logger = createCliLogger({
      sink: {
        async write(entry) {
          written.push({
            level: entry.level,
            message: entry.message,
            data: entry.data,
          })
        },
      },
    })

    const runId = 'run-test' as never
    const now = Date.now()

    const executor = new module.TaskExecutor(
      makeConfig({
        logger,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield wrap({
              type: 'RunStarted',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: now,
            })
            yield wrap({
              type: 'MessageCompleted',
              runId,
              messageId: 'msg-1',
              message: {
                id: 'msg-1',
                role: 'assistant',
                content: [{ type: 'text', text: 'hello' }],
                createdAt: now,
              },
              timestamp: now,
            })
            yield wrap({
              type: 'ToolCompleted',
              runId,
              toolCallId: 'tc-1',
              invocation: { toolCallId: 'tc-1', toolName: 'read_file', args: { path: '/a.ts' } },
              result: { toolCallId: 'tc-1', result: 'file content' },
              timestamp: now,
            })
            yield wrap({
              type: 'ToolFailed',
              runId,
              toolCallId: 'tc-2',
              invocation: { toolCallId: 'tc-2', toolName: 'write_file', args: { path: '/b.ts' } },
              error: new ToolError('WRITE_DENIED', 'permission denied'),
              timestamp: now,
            })
            yield wrap({
              type: 'RunCompleted',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: now,
            })
          },
        }),
      })
    )

    await executor.execute(createCommand(createTaskId('task-001'), 'test events'))

    expect(written.some((e) => e.level === 'info' && e.message === 'Message completed')).toBe(true)
    expect(written.some((e) => e.level === 'info' && e.message === 'Tool call completed')).toBe(
      true
    )
    expect(written.some((e) => e.level === 'error' && e.message === 'Tool call failed')).toBe(true)
    expect(written.some((e) => e.level === 'info' && e.message === 'Run turn summary')).toBe(true)
  })

  it('handles events before run.started by returning null turn', async () => {
    const module = await import('../task-executor.js')
    const written: Array<{ level: string; message: string }> = []
    const logger = createCliLogger({
      sink: {
        async write(entry) {
          written.push({ level: entry.level, message: entry.message })
        },
      },
    })

    const runId = 'run-test' as never
    const now = Date.now()

    const executor = new module.TaskExecutor(
      makeConfig({
        logger,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            // 先发 message.completed，此时 turn 为 null，应被忽略
            yield wrap({
              type: 'MessageCompleted',
              runId,
              messageId: 'msg-orphan',
              message: {
                id: 'msg-orphan',
                role: 'assistant',
                content: [{ type: 'text', text: 'orphan' }],
                createdAt: now,
              },
              timestamp: now,
            })
            yield wrap({
              type: 'RunStarted',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: now,
            })
            yield wrap({
              type: 'RunCompleted',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: now,
            })
          },
        }),
      })
    )

    await executor.execute(createCommand(createTaskId('task-001'), 'orphan event'))

    // orphan message.completed 不应产生 "Message completed" 日志
    expect(written.filter((e) => e.message === 'Message completed')).toHaveLength(0)
  })

  it('logs run.failed and run.cancelled turn summaries', async () => {
    const module = await import('../task-executor.js')
    const written: Array<{ level: string; message: string; data?: Record<string, unknown> }> = []
    const logger = createCliLogger({
      sink: {
        async write(entry) {
          written.push({ level: entry.level, message: entry.message, data: entry.data })
        },
      },
    })

    const runId = 'run-test' as never
    const now = Date.now()

    // 测试 run.failed
    const executor1 = new module.TaskExecutor(
      makeConfig({
        logger,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield wrap({
              type: 'RunStarted',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: now,
            })
            yield wrap({
              type: 'RunFailed',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              error: { category: 'internal', code: 'FAIL', message: 'failed' },
              timestamp: now,
            })
          },
        }),
      })
    )

    await executor1.execute(createCommand(createTaskId('task-001'), 'run failed'))

    const failedSummary = written.find(
      (e) =>
        e.message === 'Run turn summary' &&
        (e.data as Record<string, unknown>)?.endReason === 'RunFailed'
    )
    expect(failedSummary).toBeDefined()

    // 测试 run.cancelled
    written.length = 0
    const executor2 = new module.TaskExecutor(
      makeConfig({
        logger,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield wrap({
              type: 'RunStarted',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: now,
            })
            yield wrap({
              type: 'RunCancelled',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: now,
            })
          },
        }),
      })
    )

    await executor2.execute(createCommand(createTaskId('task-002'), 'run cancelled'))

    const cancelledSummary = written.find(
      (e) =>
        e.message === 'Run turn summary' &&
        (e.data as Record<string, unknown>)?.endReason === 'RunCancelled'
    )
    expect(cancelledSummary).toBeDefined()
  })
})
