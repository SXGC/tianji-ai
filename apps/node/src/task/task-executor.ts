/**
 * Task execution orchestration on node side.
 *
 * @module task/task-executor
 */

import type { AgentRunner } from '../acp/index.js'
import type { NdjsonWriter } from '../controlplane/index.js'

import type { Command, NodeExecutionState, NodeId } from '@tianji/shared'

export interface TaskExecutorConfig {
  readonly nodeId: NodeId
  readonly onExecutionStateChange: (state: NodeExecutionState) => void
  readonly createRunner: (command: Command) => Promise<AgentRunner>
  readonly openEventStream: (taskId: string) => Promise<NdjsonWriter>
}

export class TaskExecutor {
  readonly #config: TaskExecutorConfig
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

    this.#executionState = 'busy'
    this.#currentTaskId = String(command.payload.taskId)
    this.#config.onExecutionStateChange(this.#executionState)

    const runner = await this.#config.createRunner(command)
    const eventStream = await this.#config.openEventStream(this.#currentTaskId)

    try {
      await runner.connect()
      for await (const _event of runner.chat(command.payload.goal)) {
        await eventStream.write('{}')
      }
    } finally {
      await runner.disconnect()
      await eventStream.close()
      this.#executionState = 'idle'
      this.#currentTaskId = null
      this.#config.onExecutionStateChange(this.#executionState)
    }
  }
}
