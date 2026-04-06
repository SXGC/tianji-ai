import { type Command, createNodeId, createTaskId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import type { AgentRunner } from '../../acp/index.js'
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

function createRunnerStub(): AgentRunner {
  return {
    agentId: 'default',
    connect: async () => undefined,
    disconnect: async () => undefined,
    async *chat() {
      yield {
        type: 'run.completed',
        runId: 'run-test' as never,
        sessionId: 'session-test' as never,
        triggerType: 'new',
        timestamp: Date.now(),
      }
    },
  } as unknown as AgentRunner
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
      written.some(
        (entry) => entry.level === 'debug' && entry.message === 'Forwarding task runtime event'
      )
    ).toBe(true)
  })

  it('writes task.failed lifecycle event when runner chat throws', async () => {
    const module = await import('../task-executor.js')
    const writes: string[] = []
    const failure = new Error('runner exploded')

    const executor = new module.TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      createRunner: async () =>
        ({
          agentId: 'default',
          connect: async () => undefined,
          disconnect: async () => undefined,
          async *chat() {
            yield undefined as never
            throw failure
          },
        }) as unknown as AgentRunner,
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
})
