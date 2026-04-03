import { createNodeId, createTaskId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import type { TaskExecutorConfig } from '../task-executor.js'

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
      createRunner: async () => ({
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
      }),
      openEventStream: async () => ({
        write: async () => undefined,
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

    const first = executor.execute({
      commandId: 'command-001' as never,
      type: 'task.run',
      payload: {
        taskId,
        agentId: 'default',
        goal: 'first',
      },
    })

    await expect(
      executor.execute({
        commandId: 'command-002' as never,
        type: 'task.run',
        payload: {
          taskId: createTaskId('task-002'),
          agentId: 'default',
          goal: 'second',
        },
      })
    ).rejects.toThrow(/already executing/i)

    await first
  })
})
