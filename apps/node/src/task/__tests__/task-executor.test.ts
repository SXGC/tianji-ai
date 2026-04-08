import { type Command, ToolError, createNodeId, createTaskId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

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
        type: 'run.started',
        runId: 'run-test' as never,
        sessionId: 'session-test' as never,
        triggerType: 'new',
        timestamp: Date.now(),
      }
      yield {
        type: 'run.completed',
        runId: 'run-test' as never,
        sessionId: 'session-test' as never,
        triggerType: 'new',
        timestamp: Date.now(),
      }
    },
  }
}

describe('TaskExecutorConfig', () => {
  it('should define required fields', () => {
    const config: TaskExecutorConfig = {
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      createRunner: async () => {
        throw new Error('not implemented')
      },
      openEventStream: async () => ({
        write: async () => undefined,
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    }

    expect(config.nodeId).toBe(createNodeId('node-001'))
  })

  it('should expose idle execution state by default', async () => {
    const module = await import('../task-executor.js')
    const executor = new module.TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      createRunner: async () => {
        throw new Error('not implemented')
      },
      openEventStream: async () => ({
        write: async () => undefined,
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

    expect(executor.executionState).toBe('idle')
    expect(executor.currentTaskId).toBeNull()
  })

  it('should reject starting a second task while busy', async () => {
    const module = await import('../task-executor.js')
    const taskId = createTaskId('task-001')

    const executor = new module.TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      createRunner: async () => createRunnerStub(),
      openEventStream: async () => ({
        write: async () => undefined,
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

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

    const executor = new module.TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      logger,
      createRunner: async () => createRunnerStub(),
      openEventStream: async () => ({
        write: async () => undefined,
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

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

  it('writes task.failed lifecycle event when runner query throws', async () => {
    const module = await import('../task-executor.js')
    const writes: string[] = []
    const failure = new Error('runner exploded')

    const executor = new module.TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      createRunner: async () => ({
        agentId: 'default',
        connect: async () => undefined,
        disconnect: async () => undefined,
        async *query() {
          yield undefined as never
          throw failure
        },
      }),
      openEventStream: async () => ({
        write: async (json: string) => {
          writes.push(json)
        },
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

    await expect(executor.execute(createCommand(createTaskId('task-001'), 'boom'))).rejects.toThrow(
      'runner exploded'
    )

    expect(writes).toHaveLength(3)
    expect(JSON.parse(writes[0] ?? 'null')).toMatchObject({
      kind: 'lifecycle',
      sequence: 1,
      type: 'task.started',
    })
    expect(JSON.parse(writes[1] ?? 'null')).toMatchObject({
      kind: 'agent',
      sequence: 2,
    })
    expect(JSON.parse(writes[2] ?? 'null')).toMatchObject({
      kind: 'lifecycle',
      sequence: 3,
      type: 'task.failed',
      error: 'runner exploded',
    })
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

    const executor = new module.TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      logger,
      createRunner: async () => ({
        agentId: 'default',
        connect: async () => undefined,
        disconnect: async () => undefined,
        async *query() {
          yield {
            type: 'run.started',
            runId,
            sessionId: 'session-test' as never,
            triggerType: 'new',
            timestamp: now,
          }
          yield {
            type: 'message.completed',
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
            type: 'tool.completed',
            runId,
            toolCallId: 'tc-1',
            invocation: { toolCallId: 'tc-1', toolName: 'read_file', args: { path: '/a.ts' } },
            result: { toolCallId: 'tc-1', result: 'file content' },
            timestamp: now,
          }
          yield {
            type: 'tool.failed',
            runId,
            toolCallId: 'tc-2',
            invocation: { toolCallId: 'tc-2', toolName: 'write_file', args: { path: '/b.ts' } },
            error: new ToolError('WRITE_DENIED', 'permission denied'),
            timestamp: now,
          }
          yield {
            type: 'run.completed',
            runId,
            sessionId: 'session-test' as never,
            triggerType: 'new',
            timestamp: now,
          }
        },
      }),
      openEventStream: async () => ({
        write: async () => undefined,
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

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

    const executor = new module.TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      logger,
      createRunner: async () => ({
        agentId: 'default',
        connect: async () => undefined,
        disconnect: async () => undefined,
        async *query() {
          // 先发 message.completed，此时 turn 为 null，应被忽略
          yield {
            type: 'message.completed',
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
            type: 'run.started',
            runId,
            sessionId: 'session-test' as never,
            triggerType: 'new',
            timestamp: now,
          }
          yield {
            type: 'run.completed',
            runId,
            sessionId: 'session-test' as never,
            triggerType: 'new',
            timestamp: now,
          }
        },
      }),
      openEventStream: async () => ({
        write: async () => undefined,
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

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
    const executor1 = new module.TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      logger,
      createRunner: async () => ({
        agentId: 'default',
        connect: async () => undefined,
        disconnect: async () => undefined,
        async *query() {
          yield {
            type: 'run.started',
            runId,
            sessionId: 'session-test' as never,
            triggerType: 'new',
            timestamp: now,
          }
          yield {
            type: 'run.failed',
            runId,
            sessionId: 'session-test' as never,
            triggerType: 'new',
            error: { category: 'internal', code: 'FAIL', message: 'failed' },
            timestamp: now,
          }
        },
      }),
      openEventStream: async () => ({
        write: async () => undefined,
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

    await executor1.execute(createCommand(createTaskId('task-001'), 'run failed'))

    const failedSummary = written.find(
      (e) =>
        e.message === 'Run turn summary' &&
        (e.data as Record<string, unknown>)?.endReason === 'run.failed'
    )
    expect(failedSummary).toBeDefined()

    // 测试 run.cancelled
    written.length = 0
    const executor2 = new module.TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      logger,
      createRunner: async () => ({
        agentId: 'default',
        connect: async () => undefined,
        disconnect: async () => undefined,
        async *query() {
          yield {
            type: 'run.started',
            runId,
            sessionId: 'session-test' as never,
            triggerType: 'new',
            timestamp: now,
          }
          yield {
            type: 'run.cancelled',
            runId,
            sessionId: 'session-test' as never,
            triggerType: 'new',
            timestamp: now,
          }
        },
      }),
      openEventStream: async () => ({
        write: async () => undefined,
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

    await executor2.execute(createCommand(createTaskId('task-002'), 'run cancelled'))

    const cancelledSummary = written.find(
      (e) =>
        e.message === 'Run turn summary' &&
        (e.data as Record<string, unknown>)?.endReason === 'run.cancelled'
    )
    expect(cancelledSummary).toBeDefined()
  })

  it('logs stream write failure when eventStream.write throws on task failure', async () => {
    const module = await import('../task-executor.js')
    const written: Array<{ level: string; message: string }> = []
    const logger = createCliLogger({
      sink: {
        async write(entry) {
          written.push({ level: entry.level, message: entry.message })
        },
      },
    })

    let writeCount = 0
    const executor = new module.TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      logger,
      createRunner: async () => ({
        agentId: 'default',
        connect: async () => undefined,
        disconnect: async () => undefined,
        async *query() {
          yield undefined as never
          throw new Error('runner crashed')
        },
      }),
      openEventStream: async () => ({
        write: async () => {
          writeCount++
          // task.started (seq 1) 成功, agent event (seq 2) 成功, task.failed (seq 3) 失败
          if (writeCount >= 3) {
            throw new Error('stream broken')
          }
        },
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

    await expect(executor.execute(createCommand(createTaskId('task-001'), 'boom'))).rejects.toThrow(
      'runner crashed'
    )

    expect(
      written.some((e) => e.level === 'error' && e.message === 'Failed to write task failure event')
    ).toBe(true)
  })
})
