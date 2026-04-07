/**
 * Task execution orchestration on node side.
 *
 * @module task/task-executor
 */

import type { IAgentRunner } from '../acp/index.js'
import type { NdjsonWriter } from '../controlplane/index.js'
import type { RuntimeLogger } from '../logger.js'

import type {
  Command,
  MessageCompletedEvent,
  NodeExecutionState,
  NodeId,
  RuntimeEvent,
  ToolCompletedEvent,
  ToolFailedEvent,
} from '@tianji/shared'

interface TurnSummary {
  runId: string
  events: string[]
  messages: string[]
  toolCalls: string[]
}

export interface TaskExecutorConfig {
  readonly nodeId: NodeId
  readonly onExecutionStateChange: (state: NodeExecutionState) => void
  readonly createRunner: (command: Command) => Promise<IAgentRunner>
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

      let currentTurn: TurnSummary | null = null

      for await (const event of runner.query(command.payload.goal)) {
        if (event != null) {
          currentTurn = collectTurnEvent(currentTurn, event)
        }

        const isRunEnd =
          event?.type === 'run.completed' ||
          event?.type === 'run.failed' ||
          event?.type === 'run.cancelled'

        if (isRunEnd && currentTurn !== null) {
          await this.#config.logger?.logInfo(this.#scope, 'Run turn summary', {
            taskId,
            runId: currentTurn.runId,
            endReason: event.type,
            events: currentTurn.events,
            messages: currentTurn.messages,
            toolCalls: currentTurn.toolCalls,
          })
          currentTurn = null
        }

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

function extractTextSummary(event: MessageCompletedEvent): string {
  const parts = event.message.content
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
  return parts.length > 0 ? parts.join('\n') : '(no text content)'
}

function extractToolCallSummary(event: ToolCompletedEvent | ToolFailedEvent): string {
  const status = event.type === 'tool.completed' ? 'completed' : 'failed'
  const name = event.type === 'tool.failed' ? event.invocation.toolName : event.toolCallId
  return `${name} [${status}]`
}

function collectTurnEvent(turn: TurnSummary | null, event: RuntimeEvent): TurnSummary | null {
  if (
    event.type === 'run.started' ||
    event.type === 'run.completed' ||
    event.type === 'run.failed' ||
    event.type === 'run.cancelled'
  ) {
    const current = turn ?? { runId: event.runId, events: [], messages: [], toolCalls: [] }
    current.events.push(event.type)
    return current
  }

  if (turn === null) {
    return null
  }

  turn.events.push(event.type)

  if (event.type === 'message.completed') {
    turn.messages.push(extractTextSummary(event))
  } else if (event.type === 'tool.completed' || event.type === 'tool.failed') {
    turn.toolCalls.push(extractToolCallSummary(event))
  }

  return turn
}

function serializeRuntimeEvent(event: RuntimeEvent): unknown {
  return event
}
