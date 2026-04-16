import {
  CausalContext,
  NoopSequenceRecoverer,
  SequenceCounter,
  createRuntimeEventPipeline,
} from '@tianji/runtime'
import {
  type Command,
  type DomainEvent,
  type DomainEventEnvelope,
  ProviderError,
  TianjiError,
  ToolError,
  createNodeId,
  createTaskId,
} from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import type { IAgentRunner } from '../../acp/index.js'
import { createCliLogger } from '../../logger.js'
import type { TaskExecutorConfig } from '../task-executor.js'

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
      yield {
        type: 'RunStarted',
        runId: 'run-test' as never,
        sessionId: 'session-test' as never,
        triggerType: 'new',
        timestamp: Date.now(),
      }
      yield {
        type: 'RunCompleted',
        runId: 'run-test' as never,
        sessionId: 'session-test' as never,
        triggerType: 'new',
        timestamp: Date.now(),
      }
    },
  }
}

/** 构造最小化 TaskExecutorConfig，emitEvent 默认为 vi.fn()。 */
function makeConfig(overrides: Partial<TaskExecutorConfig> = {}): TaskExecutorConfig {
  return {
    nodeId: createNodeId('node-001'),
    onExecutionStateChange: () => undefined,
    emitEvent: vi.fn(),
    enterCorrelation: async (_correlationId, fn) => fn(),
    createRunner: async () => {
      throw new Error('not implemented')
    },
    ...overrides,
  }
}

function createEnvelopeCollector() {
  const publishedEnvelopes: DomainEventEnvelope[] = []
  const contextRef = { current: CausalContext.root('task-test-correlation') }
  const pipeline = createRuntimeEventPipeline({
    publish: (env) => publishedEnvelopes.push(env),
    counter: new SequenceCounter(),
    contextProvider: {
      getCurrent: () => contextRef.current,
      update: (next) => {
        contextRef.current = next
      },
    },
    source: { processKind: 'node', processId: 'test-node', nodeId: createNodeId('node-001') },
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

  const groupedSequences = new Map<string, number[]>()
  for (const env of runEnvelopes) {
    const sequences = groupedSequences.get(env.aggregateId) ?? []
    sequences.push(env.sequence)
    groupedSequences.set(env.aggregateId, sequences)
  }

  for (const sequences of groupedSequences.values()) {
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]).toBeGreaterThanOrEqual(sequences[index - 1])
    }
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

  it('wraps task execution in a task correlation context', async () => {
    const module = await import('../task-executor.js')
    const enterCorrelationCalls: string[] = []
    const enterCorrelation: TaskExecutorConfig['enterCorrelation'] = async (_correlationId, fn) => {
      enterCorrelationCalls.push(_correlationId)
      return fn()
    }

    const executor = new module.TaskExecutor(
      makeConfig({
        enterCorrelation,
        createRunner: async () => createRunnerStub(),
      })
    )

    const taskId = createTaskId('task-ctx')
    const command = createCommand(taskId, 'success')

    await executor.execute(command)

    expect(enterCorrelationCalls).toEqual([String(taskId)])
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
            yield {
              type: 'RunStarted',
              runId: 'run-test' as never,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: Date.now(),
            }
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

    // TaskFailed.error 必须携带原始错误消息与 code（普通 Error.name 默认为 'Error'）
    const failedEvent = emitEvent.mock.calls.find(
      (call) => (call[0] as DomainEvent).type === 'TaskFailed'
    )?.[0] as Extract<DomainEvent, { type: 'TaskFailed' }> | undefined
    expect(failedEvent?.error).toBeInstanceOf(TianjiError)
    expect(failedEvent?.error.message).toBe('runner exploded')
    expect(failedEvent?.error.code).toBe('Error')
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
            yield {
              type: 'RunStarted',
              runId: 'run-test' as never,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: Date.now(),
            }
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

  it('publishes runner output via emitEvent instead of publishEnvelope', async () => {
    const module = await import('../task-executor.js')
    const emitEvent = vi.fn()
    const { publishedEnvelopes, emitEvent: emitEnvelopeEvent } = createEnvelopeCollector()

    const executor = new module.TaskExecutor(
      makeConfig({
        emitEvent: async (event) => {
          emitEvent(event)
          await emitEnvelopeEvent(event)
        },
        createRunner: async () => createRunnerStub(),
      })
    )

    await executor.execute(createCommand(createTaskId('task-001'), 'envelopes'))

    const types = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([event]) => event.type)
    expect(types).toContain('TaskStarted')
    expect(types).toContain('RunStarted')
    expect(types).toContain('RunCompleted')
    expect(types).toContain('TaskCompleted')
    assertNoSyntheticRunEnvelopes(publishedEnvelopes)
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
            yield {
              type: 'RunStarted',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: now,
            }
            yield {
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
            }
            yield {
              type: 'ToolCompleted',
              runId,
              toolCallId: 'tc-1',
              invocation: { toolCallId: 'tc-1', toolName: 'read_file', args: { path: '/a.ts' } },
              result: { toolCallId: 'tc-1', result: 'file content' },
              timestamp: now,
            }
            yield {
              type: 'ToolFailed',
              runId,
              toolCallId: 'tc-2',
              invocation: { toolCallId: 'tc-2', toolName: 'write_file', args: { path: '/b.ts' } },
              error: new ToolError('WRITE_DENIED', 'permission denied'),
              timestamp: now,
            }
            yield {
              type: 'RunCompleted',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: now,
            }
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
            yield {
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
            }
            yield {
              type: 'RunStarted',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: now,
            }
            yield {
              type: 'RunCompleted',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: now,
            }
          },
        }),
      })
    )

    await executor.execute(createCommand(createTaskId('task-001'), 'orphan event'))

    // orphan message.completed 不应产生 "Message completed" 日志
    expect(written.filter((e) => e.message === 'Message completed')).toHaveLength(0)
  })

  it('镜像 MessageStarted 为 TaskMessageStarted，保留 messageId 且 role=assistant', async () => {
    const module = await import('../task-executor.js')
    const emitEvent = vi.fn()
    const runId = 'run-mirror' as never
    const now = Date.now()
    const taskId = createTaskId('task-mirror-1')

    const executor = new module.TaskExecutor(
      makeConfig({
        emitEvent,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield {
              type: 'RunStarted',
              runId,
              sessionId: 'session-mirror' as never,
              triggerType: 'new',
              timestamp: now,
            }
            yield {
              type: 'MessageStarted',
              runId,
              messageId: 'msg-mirror-1',
              message: {
                id: 'msg-mirror-1',
                role: 'assistant',
                content: [],
                createdAt: now,
              },
              timestamp: now,
            }
            yield {
              type: 'RunCompleted',
              runId,
              sessionId: 'session-mirror' as never,
              triggerType: 'new',
              timestamp: now,
            }
          },
        }),
      })
    )

    await executor.execute(createCommand(taskId, 'mirror started'))

    const events = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e)
    const runLevel = events.find((e) => e.type === 'MessageStarted')
    const taskLevel = events.find((e) => e.type === 'TaskMessageStarted')
    expect(runLevel).toBeDefined()
    expect(taskLevel).toBeDefined()
    const mirrored = taskLevel as Extract<DomainEvent, { type: 'TaskMessageStarted' }>
    expect(mirrored.taskId).toBe(String(taskId))
    expect(mirrored.messageId).toBe('msg-mirror-1')
    expect(mirrored.role).toBe('assistant')
    // task 级事件紧跟 run 级事件
    const runIdx = events.indexOf(runLevel as DomainEvent)
    const taskIdx = events.indexOf(taskLevel as DomainEvent)
    expect(taskIdx).toBe(runIdx + 1)
  })

  it('镜像 MessageDelta 为 TaskMessageDelta，保留 channel/sequence/payload', async () => {
    const module = await import('../task-executor.js')
    const emitEvent = vi.fn()
    const runId = 'run-mirror-delta' as never
    const now = Date.now()
    const taskId = createTaskId('task-mirror-2')

    const executor = new module.TaskExecutor(
      makeConfig({
        emitEvent,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield {
              type: 'RunStarted',
              runId,
              sessionId: 'session-mirror-2' as never,
              triggerType: 'new',
              timestamp: now,
            }
            yield {
              type: 'MessageDelta',
              runId,
              messageId: 'msg-d-1',
              sequence: 7,
              channel: 'thinking',
              payload: { content: 'pondering…' },
              timestamp: now,
            }
            yield {
              type: 'RunCompleted',
              runId,
              sessionId: 'session-mirror-2' as never,
              triggerType: 'new',
              timestamp: now,
            }
          },
        }),
      })
    )

    await executor.execute(createCommand(taskId, 'mirror delta'))

    const events = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e)
    const taskDelta = events.find((e) => e.type === 'TaskMessageDelta') as
      | Extract<DomainEvent, { type: 'TaskMessageDelta' }>
      | undefined
    expect(taskDelta).toBeDefined()
    expect(taskDelta?.taskId).toBe(String(taskId))
    expect(taskDelta?.messageId).toBe('msg-d-1')
    expect(taskDelta?.channel).toBe('thinking')
    expect(taskDelta?.sequence).toBe(7)
    expect(taskDelta?.payload.content).toBe('pondering…')
  })

  it('镜像 MessageCompleted 为 TaskMessageCompleted，携带完整 message', async () => {
    const module = await import('../task-executor.js')
    const emitEvent = vi.fn()
    const runId = 'run-mirror-complete' as never
    const now = Date.now()
    const taskId = createTaskId('task-mirror-3')
    const finalMessage = {
      id: 'msg-final',
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'final answer' }],
      createdAt: now,
    }

    const executor = new module.TaskExecutor(
      makeConfig({
        emitEvent,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield {
              type: 'RunStarted',
              runId,
              sessionId: 'session-mirror-3' as never,
              triggerType: 'new',
              timestamp: now,
            }
            yield {
              type: 'MessageCompleted',
              runId,
              messageId: 'msg-final',
              message: finalMessage,
              timestamp: now,
            }
            yield {
              type: 'RunCompleted',
              runId,
              sessionId: 'session-mirror-3' as never,
              triggerType: 'new',
              timestamp: now,
            }
          },
        }),
      })
    )

    await executor.execute(createCommand(taskId, 'mirror completed'))

    const events = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e)
    const taskCompleted = events.find((e) => e.type === 'TaskMessageCompleted') as
      | Extract<DomainEvent, { type: 'TaskMessageCompleted' }>
      | undefined
    expect(taskCompleted).toBeDefined()
    expect(taskCompleted?.taskId).toBe(String(taskId))
    expect(taskCompleted?.messageId).toBe('msg-final')
    expect(taskCompleted?.message).toEqual(finalMessage)
    const order = events.map((e) => e.type)
    const runIdx = order.indexOf('MessageCompleted')
    const taskIdx = order.indexOf('TaskMessageCompleted')
    expect(taskIdx).toBeGreaterThan(runIdx)
  })

  it('非 assistant 角色的 MessageStarted/MessageCompleted 不产生 TaskMessage* 镜像', async () => {
    const module = await import('../task-executor.js')
    const emitEvent = vi.fn()
    const runId = 'run-mirror-skip' as never
    const now = Date.now()
    const taskId = createTaskId('task-mirror-skip')

    const executor = new module.TaskExecutor(
      makeConfig({
        emitEvent,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield {
              type: 'RunStarted',
              runId,
              sessionId: 'session-mirror-skip' as never,
              triggerType: 'new',
              timestamp: now,
            }
            // user 消息不应镜像
            yield {
              type: 'MessageStarted',
              runId,
              messageId: 'msg-user-1',
              message: {
                id: 'msg-user-1',
                role: 'user',
                content: [{ type: 'text', text: 'hi' }],
                createdAt: now,
              },
              timestamp: now,
            }
            yield {
              type: 'MessageCompleted',
              runId,
              messageId: 'msg-user-1',
              message: {
                id: 'msg-user-1',
                role: 'user',
                content: [{ type: 'text', text: 'hi' }],
                createdAt: now,
              },
              timestamp: now,
            }
            // tool 消息也不应镜像
            yield {
              type: 'MessageStarted',
              runId,
              messageId: 'msg-tool-1',
              message: {
                id: 'msg-tool-1',
                role: 'tool',
                content: [{ type: 'tool_result', toolCallId: 't-1', output: 'ok' }],
                createdAt: now,
              },
              timestamp: now,
            }
            yield {
              type: 'RunCompleted',
              runId,
              sessionId: 'session-mirror-skip' as never,
              triggerType: 'new',
              timestamp: now,
            }
          },
        }),
      })
    )

    await executor.execute(createCommand(taskId, 'no mirror for non-assistant'))

    const events = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e)
    const taskMessages = events.filter(
      (e) =>
        e.type === 'TaskMessageStarted' ||
        e.type === 'TaskMessageDelta' ||
        e.type === 'TaskMessageCompleted'
    )
    expect(taskMessages).toEqual([])
    // run 级消息仍然被原样发出，只是不做 task 镜像
    expect(events.some((e) => e.type === 'MessageStarted')).toBe(true)
  })

  // ── Task 1.2：Run 终端分发 Task 终端 + error 透传 ─────────────────────────────

  it('yield RunCompleted 时发 TaskCompleted（而非 TaskFailed）', async () => {
    const module = await import('../task-executor.js')
    const emitEvent = vi.fn()
    const runId = 'run-dispatch-completed' as never
    const now = Date.now()

    const executor = new module.TaskExecutor(
      makeConfig({
        emitEvent,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield {
              type: 'RunStarted',
              runId,
              sessionId: 'session-dispatch' as never,
              triggerType: 'new',
              timestamp: now,
            }
            yield {
              type: 'RunCompleted',
              runId,
              sessionId: 'session-dispatch' as never,
              triggerType: 'new',
              timestamp: now,
            }
          },
        }),
      })
    )

    await executor.execute(createCommand(createTaskId('task-dispatch-1'), 'dispatch completed'))

    const emittedTypes = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e.type)
    expect(emittedTypes).toContain('TaskCompleted')
    expect(emittedTypes).not.toContain('TaskFailed')
  })

  it('yield RunFailed 时发 TaskFailed，error 透传自 RunFailed.error', async () => {
    const module = await import('../task-executor.js')
    const emitEvent = vi.fn()
    const runId = 'run-dispatch-failed' as never
    const now = Date.now()
    const runFailedError = new ProviderError('PROVIDER_HTTP_500', '500 empty_stream')

    const executor = new module.TaskExecutor(
      makeConfig({
        emitEvent,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield {
              type: 'RunStarted',
              runId,
              sessionId: 'session-dispatch-failed' as never,
              triggerType: 'new',
              timestamp: now,
            }
            yield {
              type: 'RunFailed',
              runId,
              sessionId: 'session-dispatch-failed' as never,
              triggerType: 'new',
              error: runFailedError,
              timestamp: now,
            }
          },
        }),
      })
    )

    await executor.execute(createCommand(createTaskId('task-dispatch-2'), 'dispatch failed'))

    const emittedTypes = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e.type)
    expect(emittedTypes).toContain('TaskStarted')
    expect(emittedTypes).toContain('TaskFailed')
    expect(emittedTypes).not.toContain('TaskCompleted')

    const failedEvent = (emitEvent.mock.calls as Array<[DomainEvent]>)
      .map(([e]) => e)
      .find((e) => e.type === 'TaskFailed') as
      | Extract<DomainEvent, { type: 'TaskFailed' }>
      | undefined
    expect(failedEvent?.error.code).toBe('PROVIDER_HTTP_500')
    expect(failedEvent?.error.message).toBe('500 empty_stream')
    // error 是同一个实例（直接透传）
    expect(failedEvent?.error).toBe(runFailedError)
  })

  it('yield RunCancelled 时发 TaskCancelled（而非 TaskFailed/TaskCompleted）', async () => {
    const module = await import('../task-executor.js')
    const emitEvent = vi.fn()
    const runId = 'run-dispatch-cancelled' as never
    const now = Date.now()
    const taskId = createTaskId('task-dispatch-3')

    const executor = new module.TaskExecutor(
      makeConfig({
        emitEvent,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield {
              type: 'RunStarted',
              runId,
              sessionId: 'session-dispatch-cancelled' as never,
              triggerType: 'new',
              timestamp: now,
            }
            yield {
              type: 'RunCancelled',
              runId,
              sessionId: 'session-dispatch-cancelled' as never,
              triggerType: 'new',
              reason: 'abort',
              timestamp: now,
            }
          },
        }),
      })
    )

    // Task 2.5 起 RunCancelled 正常收口为 TaskCancelled，execute 不抛错
    await executor.execute(createCommand(taskId, 'dispatch cancelled'))

    const emittedTypes = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e.type)
    expect(emittedTypes).toContain('TaskStarted')
    expect(emittedTypes).toContain('TaskCancelled')
    expect(emittedTypes).not.toContain('TaskFailed')
    expect(emittedTypes).not.toContain('TaskCompleted')

    const cancelledEvent = (emitEvent.mock.calls as Array<[DomainEvent]>)
      .map(([e]) => e)
      .find((e) => e.type === 'TaskCancelled') as
      | Extract<DomainEvent, { type: 'TaskCancelled' }>
      | undefined
    expect(cancelledEvent?.taskId).toBe(String(taskId))
  })

  it('for-await 抛 ProviderError 时，TaskFailed.error.code/message/category 透传自异常', async () => {
    const module = await import('../task-executor.js')
    const emitEvent = vi.fn()
    const runId = 'run-passthrough-error' as never
    const now = Date.now()
    const boom = new ProviderError('PROVIDER_TIMEOUT', '1200ms timeout')

    const executor = new module.TaskExecutor(
      makeConfig({
        emitEvent,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield {
              type: 'RunStarted',
              runId,
              sessionId: 'session-passthrough' as never,
              triggerType: 'new',
              timestamp: now,
            }
            throw boom
          },
        }),
      })
    )

    await expect(
      executor.execute(createCommand(createTaskId('task-passthrough'), 'passthrough error'))
    ).rejects.toThrow('1200ms timeout')

    const failedEvent = (emitEvent.mock.calls as Array<[DomainEvent]>)
      .map(([e]) => e)
      .find((e) => e.type === 'TaskFailed') as
      | Extract<DomainEvent, { type: 'TaskFailed' }>
      | undefined
    expect(failedEvent?.error.code).toBe('PROVIDER_TIMEOUT')
    expect(failedEvent?.error.message).toBe('1200ms timeout')
    expect(failedEvent?.error.category).toBe('provider')
  })

  it('一个 task 产出多条 assistant 消息时，各自保持独立的 TaskMessage* 链', async () => {
    const module = await import('../task-executor.js')
    const emitEvent = vi.fn()
    const runId = 'run-mirror-multi' as never
    const now = Date.now()
    const taskId = createTaskId('task-mirror-multi')

    const executor = new module.TaskExecutor(
      makeConfig({
        emitEvent,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield {
              type: 'RunStarted',
              runId,
              sessionId: 'session-mirror-multi' as never,
              triggerType: 'new',
              timestamp: now,
            }
            // 第一条消息
            yield {
              type: 'MessageStarted',
              runId,
              messageId: 'msg-a',
              message: { id: 'msg-a', role: 'assistant', content: [], createdAt: now },
              timestamp: now,
            }
            yield {
              type: 'MessageDelta',
              runId,
              messageId: 'msg-a',
              sequence: 0,
              channel: 'text',
              payload: { content: 'first ' },
              timestamp: now,
            }
            yield {
              type: 'MessageCompleted',
              runId,
              messageId: 'msg-a',
              message: {
                id: 'msg-a',
                role: 'assistant',
                content: [{ type: 'text', text: 'first' }],
                createdAt: now,
              },
              timestamp: now,
            }
            // 第二条消息（不同 messageId）
            yield {
              type: 'MessageStarted',
              runId,
              messageId: 'msg-b',
              message: { id: 'msg-b', role: 'assistant', content: [], createdAt: now },
              timestamp: now,
            }
            yield {
              type: 'MessageDelta',
              runId,
              messageId: 'msg-b',
              sequence: 0,
              channel: 'text',
              payload: { content: 'second ' },
              timestamp: now,
            }
            yield {
              type: 'MessageCompleted',
              runId,
              messageId: 'msg-b',
              message: {
                id: 'msg-b',
                role: 'assistant',
                content: [{ type: 'text', text: 'second' }],
                createdAt: now,
              },
              timestamp: now,
            }
            yield {
              type: 'RunCompleted',
              runId,
              sessionId: 'session-mirror-multi' as never,
              triggerType: 'new',
              timestamp: now,
            }
          },
        }),
      })
    )

    await executor.execute(createCommand(taskId, 'two assistant messages'))

    const events = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e)
    const taskChain = events
      .filter(
        (e) =>
          e.type === 'TaskMessageStarted' ||
          e.type === 'TaskMessageDelta' ||
          e.type === 'TaskMessageCompleted'
      )
      .map((e) => {
        const msg = e as
          | Extract<DomainEvent, { type: 'TaskMessageStarted' }>
          | Extract<DomainEvent, { type: 'TaskMessageDelta' }>
          | Extract<DomainEvent, { type: 'TaskMessageCompleted' }>
        return { type: msg.type, messageId: msg.messageId }
      })

    expect(taskChain).toEqual([
      { type: 'TaskMessageStarted', messageId: 'msg-a' },
      { type: 'TaskMessageDelta', messageId: 'msg-a' },
      { type: 'TaskMessageCompleted', messageId: 'msg-a' },
      { type: 'TaskMessageStarted', messageId: 'msg-b' },
      { type: 'TaskMessageDelta', messageId: 'msg-b' },
      { type: 'TaskMessageCompleted', messageId: 'msg-b' },
    ])
  })

  it('logs run.failed turn summary and emits TaskFailed', async () => {
    const module = await import('../task-executor.js')
    const written: Array<{ level: string; message: string; data?: Record<string, unknown> }> = []
    const emitEvent = vi.fn()
    const logger = createCliLogger({
      sink: {
        async write(entry) {
          written.push({ level: entry.level, message: entry.message, data: entry.data })
        },
      },
    })

    const runId = 'run-test' as never
    const now = Date.now()

    // 测试 run.failed：循环正常结束，分发 TaskFailed（非 TaskCompleted）
    const executor1 = new module.TaskExecutor(
      makeConfig({
        logger,
        emitEvent,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield {
              type: 'RunStarted',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: now,
            }
            yield {
              type: 'RunFailed',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              error: new TianjiError('internal', 'FAIL', 'failed'),
              timestamp: now,
            }
          },
        }),
      })
    )

    await executor1.execute(createCommand(createTaskId('task-001'), 'run failed'))

    // turn summary 日志仍存在
    const failedSummary = written.find(
      (e) =>
        e.message === 'Run turn summary' &&
        (e.data as Record<string, unknown>)?.endReason === 'RunFailed'
    )
    expect(failedSummary).toBeDefined()

    // 分发 TaskFailed，而非 TaskCompleted
    const emittedTypes = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e.type)
    expect(emittedTypes).toContain('TaskFailed')
    expect(emittedTypes).not.toContain('TaskCompleted')
  })

  it('logs run.cancelled turn summary and emits TaskCancelled', async () => {
    const module = await import('../task-executor.js')
    const written: Array<{ level: string; message: string; data?: Record<string, unknown> }> = []
    const emitEvent = vi.fn()
    const logger = createCliLogger({
      sink: {
        async write(entry) {
          written.push({ level: entry.level, message: entry.message, data: entry.data })
        },
      },
    })

    const runId = 'run-test' as never
    const now = Date.now()

    // 测试 run.cancelled：循环正常结束，分发 TaskCancelled
    const executor2 = new module.TaskExecutor(
      makeConfig({
        logger,
        emitEvent,
        createRunner: async () => ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *query() {
            yield {
              type: 'RunStarted',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              timestamp: now,
            }
            yield {
              type: 'RunCancelled',
              runId,
              sessionId: 'session-test' as never,
              triggerType: 'new',
              reason: 'abort',
              timestamp: now,
            }
          },
        }),
      })
    )

    await executor2.execute(createCommand(createTaskId('task-002'), 'run cancelled'))

    // turn summary 日志
    const cancelledSummary = written.find(
      (e) =>
        e.message === 'Run turn summary' &&
        (e.data as Record<string, unknown>)?.endReason === 'RunCancelled'
    )
    expect(cancelledSummary).toBeDefined()

    // 分发 TaskCancelled，而非 TaskFailed/TaskCompleted
    const emittedTypes = (emitEvent.mock.calls as Array<[DomainEvent]>).map(([e]) => e.type)
    expect(emittedTypes).toContain('TaskCancelled')
    expect(emittedTypes).not.toContain('TaskFailed')
    expect(emittedTypes).not.toContain('TaskCompleted')
  })
})
