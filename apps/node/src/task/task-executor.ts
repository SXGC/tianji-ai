/**
 * Task execution orchestration on node side.
 *
 * @module task/task-executor
 */

import type { AgentRunner } from '../acp/index.js'
import type { NdjsonWriter } from '../controlplane/index.js'
import type { RuntimeLogger } from '../logger.js'

import type { Command, NodeExecutionState, NodeId, RuntimeEvent } from '@tianji/shared'

export interface TaskExecutorConfig {
  readonly nodeId: NodeId
  readonly onExecutionStateChange: (state: NodeExecutionState) => void
  readonly createRunner: (command: Command) => Promise<AgentRunner>
  readonly openEventStream: (taskId: string) => Promise<NdjsonWriter>
  readonly logger?: RuntimeLogger
}

export class TaskExecutor {
  readonly #config: TaskExecutorConfig
  readonly #scope = ['daemon', 'task'] as const
  #executionState: NodeExecutionState = 'idle'
  #currentTaskId: string | null = null

  constructor(config: TaskExecutorConfig) {
    this.#config = config
  }

  get executionState(): NodeExecutionState {
    return this.#executionState
  }

  get currentTaskId(): string | null {
    return this.#currentTaskId
  }

  async execute(command: Command): Promise<void> {
    if (this.#executionState === 'busy') {
      throw new Error('Node is already executing a task')
    }

    const taskId = String(command.payload.taskId)
    this.#executionState = 'busy'
    this.#currentTaskId = taskId
    this.#config.onExecutionStateChange(this.#executionState)

    await this.#config.logger?.logInfo(this.#scope, 'Daemon started processing task', {
      nodeId: this.#config.nodeId,
      commandId: command.commandId,
      taskId,
      agentId: command.payload.agentId,
    })
    await this.#config.logger?.logDebug(this.#scope, 'Preparing task execution', {
      command,
    })

    const runner = await this.#config.createRunner(command)
    await this.#config.logger?.logDebug(this.#scope, 'Created task runner', {
      taskId,
      agentId: command.payload.agentId,
    })
    const eventStream = await this.#config.openEventStream(taskId)
    await this.#config.logger?.logDebug(this.#scope, 'Opened task event stream', {
      taskId,
    })
    let sequence = 2

    try {
      await this.#config.logger?.logDebug(this.#scope, 'Writing task started lifecycle event', {
        taskId,
        sequence: 1,
      })
      await eventStream.write(
        JSON.stringify({
          kind: 'lifecycle',
          sequence: 1,
          type: 'task.started',
        })
      )

      await runner.connect()
      await this.#config.logger?.logDebug(this.#scope, 'Connected task runner', {
        taskId,
      })
      for await (const event of runner.chat(command.payload.goal)) {
        await this.#config.logger?.logDebug(this.#scope, 'Forwarding task runtime event', {
          taskId,
          sequence,
          eventType: event.type,
        })
        await eventStream.write(
          JSON.stringify({
            kind: 'agent',
            sequence,
            event: serializeRuntimeEvent(event),
          })
        )
        sequence += 1
      }

      await this.#config.logger?.logDebug(this.#scope, 'Writing task completed lifecycle event', {
        taskId,
        sequence,
      })
      await eventStream.write(
        JSON.stringify({
          kind: 'lifecycle',
          sequence,
          type: 'task.completed',
        })
      )
      await this.#config.logger?.logDebug(this.#scope, 'Task execution finished successfully', {
        taskId,
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      await this.#config.logger?.logError(this.#scope, 'Task execution failed', {
        taskId,
        error: errorMessage,
      })

      try {
        await eventStream.write(
          JSON.stringify({
            kind: 'lifecycle',
            sequence,
            type: 'task.failed',
            error: errorMessage,
          })
        )
      } catch (streamError) {
        await this.#config.logger?.logError(this.#scope, 'Failed to write task failure event', {
          taskId,
          error: streamError instanceof Error ? streamError.message : String(streamError),
        })
      }

      throw error
    } finally {
      await this.#config.logger?.logDebug(this.#scope, 'Cleaning up task execution resources', {
        taskId,
      })
      await runner.disconnect()
      await eventStream.close()
      this.#executionState = 'idle'
      this.#currentTaskId = null
      this.#config.onExecutionStateChange(this.#executionState)
      await this.#config.logger?.logDebug(this.#scope, 'Task executor returned to idle', {
        taskId,
        nodeId: this.#config.nodeId,
      })
    }
  }
}

function serializeRuntimeEvent(event: RuntimeEvent): unknown {
  return event
}
