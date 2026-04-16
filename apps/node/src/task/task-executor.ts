/**
 * Task execution orchestration on node side.
 *
 * @module task/task-executor
 */

import type { IAgentRunner } from '../acp/index.js'
import type { RuntimeLogger } from '../logger.js'

import type { ObserverLogScope } from '@tianji/observer'
import type {
  Command,
  DomainEvent,
  MessageCompletedEvent,
  NodeExecutionState,
  NodeId,
  TaskMessageCompletedEvent,
  TaskMessageDeltaEvent,
  TaskMessageStartedEvent,
  ToolCompletedEvent,
  ToolFailedEvent,
} from '@tianji/shared'
import { TianjiError } from '@tianji/shared'

interface TurnSummary {
  runId: string
  eventCount: number
  messageCount: number
  toolCallCount: number
}

export interface TaskExecutorConfig {
  readonly nodeId: NodeId
  readonly onExecutionStateChange: (state: NodeExecutionState) => void
  readonly createRunner: (command: Command) => Promise<IAgentRunner>
  /** 在任务级入口建立独立因果链上下文。 */
  readonly enterCorrelation: <T>(correlationId: string, fn: () => Promise<T>) => Promise<T>
  /**
   * 发射 Task 生命周期领域事件与 runner 产出的领域事件。
   * 事件经 pipeline 包装后进入 bus，由 forwarder 批量转发至 cp。
   */
  readonly emitEvent: (event: DomainEvent) => void
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
    return this.#config.enterCorrelation(taskId, async () => {
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

      const now = (): number => Date.now()

      try {
        await this.#config.logger?.logDebug(this.#scope, 'Emitting TaskStarted lifecycle event', {
          taskId,
        })
        this.#config.emitEvent({ type: 'TaskStarted', taskId, timestamp: now() })

        await runner.connect()
        await this.#config.logger?.logDebug(this.#scope, 'Connected task runner', {
          taskId,
        })

        let turn: TurnSummary | null = null
        let sawTerminalRunEvent = false

        for await (const event of runner.query(command.payload.goal)) {
          turn = await handleEvent(this.#config.logger, this.#scope, taskId, turn, event)
          if (
            event.type === 'RunCompleted' ||
            event.type === 'RunFailed' ||
            event.type === 'RunCancelled'
          ) {
            sawTerminalRunEvent = true
          }

          this.#config.emitEvent(event)

          const mirrored = mirrorRunMessageToTaskMessage(taskId, event, now())
          if (mirrored !== null) {
            this.#config.emitEvent(mirrored)
          }
        }

        if (!sawTerminalRunEvent) {
          throw new Error('Agent run ended without a terminal event')
        }

        await this.#config.logger?.logDebug(this.#scope, 'Emitting TaskCompleted lifecycle event', {
          taskId,
        })
        this.#config.emitEvent({ type: 'TaskCompleted', taskId, timestamp: now() })
        await this.#config.logger?.logDebug(this.#scope, 'Task execution finished successfully', {
          taskId,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        await this.#config.logger?.logError(this.#scope, 'Task execution failed', {
          taskId,
          error: errorMessage,
        })

        this.#config.emitEvent({
          type: 'TaskFailed',
          taskId,
          timestamp: now(),
          error: new TianjiError('internal', 'TASK_EXECUTION_FAILED', errorMessage),
        })

        throw error
      } finally {
        await this.#config.logger?.logDebug(this.#scope, 'Cleaning up task execution resources', {
          taskId,
        })
        await runner.disconnect()
        this.#executionState = 'idle'
        this.#currentTaskId = null
        this.#config.onExecutionStateChange(this.#executionState)
        await this.#config.logger?.logDebug(this.#scope, 'Task executor returned to idle', {
          taskId,
          nodeId: this.#config.nodeId,
        })
      }
    })
  }
}

function extractTextContent(event: MessageCompletedEvent): string {
  const parts = event.message.content
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
  return parts.length > 0 ? parts.join('\n') : '(no text content)'
}

function extractToolCallLabel(event: ToolCompletedEvent | ToolFailedEvent): string {
  const status = event.type === 'ToolCompleted' ? 'completed' : 'failed'
  return `${event.invocation.toolName} [${status}]`
}

async function handleEvent(
  logger: RuntimeLogger | undefined,
  scope: ObserverLogScope,
  taskId: string,
  turn: TurnSummary | null,
  event: DomainEvent
): Promise<TurnSummary | null> {
  if (event.type === 'RunStarted') {
    return { runId: event.runId, eventCount: 1, messageCount: 0, toolCallCount: 0 }
  }

  if (turn === null) {
    return null
  }

  turn.eventCount += 1

  if (event.type === 'MessageCompleted') {
    turn.messageCount += 1
    await logger?.logInfo(scope, 'Message completed', {
      taskId,
      runId: event.runId,
      messageId: event.messageId,
      content: extractTextContent(event),
    })
  } else if (event.type === 'ToolCompleted') {
    turn.toolCallCount += 1
    await logger?.logInfo(scope, 'Tool call completed', {
      taskId,
      runId: event.runId,
      toolCallId: event.toolCallId,
      toolCall: extractToolCallLabel(event),
      args: event.invocation.args,
      result: event.result.result,
    })
  } else if (event.type === 'ToolFailed') {
    turn.toolCallCount += 1
    await logger?.logError(scope, 'Tool call failed', {
      taskId,
      runId: event.runId,
      toolCallId: event.toolCallId,
      toolCall: extractToolCallLabel(event),
      args: event.invocation.args,
      errorCode: event.error.code,
      errorMessage: event.error.message,
    })
  } else if (
    event.type === 'RunCompleted' ||
    event.type === 'RunFailed' ||
    event.type === 'RunCancelled'
  ) {
    await logger?.logInfo(scope, 'Run turn summary', {
      taskId,
      runId: turn.runId,
      endReason: event.type,
      eventCount: turn.eventCount,
      messageCount: turn.messageCount,
      toolCallCount: turn.toolCallCount,
    })
    return null
  }

  return turn
}

/**
 * 将 run 级 Message* 事件镜像为 task 级 TaskMessage* 事件。
 * run 级原事件保留给 observability / 审计；task 级镜像用于 controlplane 展示。
 *
 * 只镜像 assistant 消息：`MessageDelta` 在当前 ACP 协议下仅由 agent_message_chunk /
 * agent_thought_chunk 产生（见 event-adapter），语义天然是 assistant。
 *
 * @param taskId    - 任务 ID，用作 task 级事件的 aggregateId
 * @param event     - runner 产出的裸领域事件
 * @param timestamp - 镜像事件发射时间
 * @returns 对应的 TaskMessage* 事件；非消息事件返回 null
 */
function mirrorRunMessageToTaskMessage(
  taskId: string,
  event: DomainEvent,
  timestamp: number
): TaskMessageStartedEvent | TaskMessageDeltaEvent | TaskMessageCompletedEvent | null {
  if (event.type === 'MessageStarted') {
    if (event.message.role !== 'assistant') return null
    return {
      type: 'TaskMessageStarted',
      taskId,
      messageId: event.messageId,
      role: 'assistant',
      timestamp,
    }
  }

  if (event.type === 'MessageDelta') {
    return {
      type: 'TaskMessageDelta',
      taskId,
      messageId: event.messageId,
      sequence: event.sequence,
      channel: event.channel,
      payload: event.payload,
      timestamp,
    }
  }

  if (event.type === 'MessageCompleted') {
    if (event.message.role !== 'assistant') return null
    return {
      type: 'TaskMessageCompleted',
      taskId,
      messageId: event.messageId,
      message: event.message,
      timestamp,
    }
  }

  return null
}
