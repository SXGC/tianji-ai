import type { AgentExecutorFactory, LoadedAgentContext, OrchestrationGraph } from '@tianji/agent'
import type { ObserverLogger } from '@tianji/observer'
import type {
  AgentInfo,
  Command,
  DomainEvent,
  NodeExecutionState,
  NodeId,
  PollCommandResponse,
  TaskRunCommand,
  TianjiAgentConfig,
} from '@tianji/shared'

import { resolveAgentType } from '@tianji/shared'

import { AgentRunner, InProcessAgentRunner } from '../acp/index.js'
import { ControlPlaneConnection, type ControlPlaneConnectionConfig } from '../controlplane/index.js'
import type { RuntimeLogger } from '../logger.js'
import { ActiveExecutorRegistry } from '../task/active-executor-registry.js'
import { TaskExecutor, type TaskExecutorConfig } from '../task/task-executor.js'

export interface ControlPlaneRuntimeConfig {
  readonly baseUrl: string
  readonly nodeId: NodeId
  readonly enrollmentToken: string
  readonly hostname: string
  readonly platform: string
  readonly version: string
  readonly agentConfigs: Readonly<Record<string, TianjiAgentConfig>>
  readonly agentList: readonly AgentInfo[]
  readonly nativeAgentContext?: LoadedAgentContext
  readonly defaultGraph?: OrchestrationGraph
  readonly executorFactory?: AgentExecutorFactory
  readonly onConnectionStateChange?: (event: {
    status:
      | 'connecting'
      | 'connected'
      | 'heartbeat_succeeded'
      | 'heartbeat_failed'
      | 'register_failed'
    error?: string
  }) => void
  readonly logger?: RuntimeLogger
  /** 传给 SessionRuntime 的 observer logger，用于 runtime 层日志（如 token usage）。 */
  readonly observerLogger?: ObserverLogger
  /** 在任务执行入口建立独立因果链上下文。 */
  readonly enterCorrelation: <T>(correlationId: string, fn: () => Promise<T>) => Promise<T>
  /**
   * 发射 Task 生命周期领域事件与 runner 事件，由 daemon-entry 注入 node 身份的 pipeline。
   */
  readonly emitTaskEvent: (event: DomainEvent) => void
}

export interface ControlPlaneCallbacks {
  onExecutionStateChange: (state: NodeExecutionState) => void
}

export interface ControlPlaneRuntimeDeps {
  createConnection?: (config: ControlPlaneConnectionConfig) => ControlPlaneConnectionLike
  createTaskExecutor?: (callbacks: ControlPlaneCallbacks) => TaskExecutorLike
}

export interface ControlPlaneConnectionLike {
  /** 暴露给 daemon-entry 的 HTTP client，用于 forwarder 的 postDomainEvents。 */
  readonly client?: {
    postDomainEvents(ndjson: string): Promise<void>
    maxSequence(
      aggregateType: 'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node',
      aggregateId: string
    ): Promise<number | null>
  }
  start(): Promise<void>
  stop(): void
  setExecutionState(state: NodeExecutionState): void
}

export interface TaskExecutorLike {
  readonly executionState: NodeExecutionState
  readonly currentTaskId: string | null
  execute(command: TaskRunCommand): Promise<void>
  cancel(): void
}

export interface ControlPlaneRuntimeHandle {
  readonly connection: ControlPlaneConnectionLike
  readonly taskExecutor: TaskExecutorLike
  readonly onCommand: (command: Command) => Promise<void>
}

export function createControlPlaneRuntime(
  config: ControlPlaneRuntimeConfig,
  deps: ControlPlaneRuntimeDeps = {}
): ControlPlaneRuntimeHandle {
  let currentConnection: ControlPlaneConnectionLike | null = null
  let taskExecutorRef: TaskExecutorLike | null = null
  const registry = new ActiveExecutorRegistry()

  const updateExecutionState = (state: NodeExecutionState): void => {
    currentConnection?.setExecutionState(state)
  }

  const executePolledCommand = (command: PollCommandResponse): void => {
    if (taskExecutorRef === null) {
      return
    }

    switch (command.type) {
      case 'task.run': {
        const taskCommand: TaskRunCommand = {
          commandId: command.commandId,
          nodeId: config.nodeId,
          type: 'task.run',
          payload: command.payload,
          state: 'pending',
          createdAt: Date.now(),
        }
        const taskId = String(taskCommand.payload.taskId)
        registry.register(taskId, taskExecutorRef)
        taskExecutorRef
          .execute(taskCommand)
          .catch((error) => {
            config.logger
              ?.logError(['daemon', 'controlplane'], 'Failed to execute task command', {
                commandId: taskCommand.commandId,
                taskId: taskCommand.payload.taskId,
                agentId: taskCommand.payload.agentId,
                error: error instanceof Error ? error.message : String(error),
              })
              ?.catch(() => {})
          })
          .finally(() => {
            registry.unregister(taskId)
          })
        break
      }
      case 'task.cancel': {
        try {
          registry.cancel(String(command.payload.taskId))
        } catch (error) {
          config.logger
            ?.logError(['daemon', 'controlplane'], 'Failed to cancel task', {
              commandId: command.commandId,
              taskId: command.payload.taskId,
              error: error instanceof Error ? error.message : String(error),
            })
            ?.catch(() => {})
        }
        break
      }
      default: {
        const unknownCmd = command as unknown as { commandId: string; type: string }
        config.logger
          ?.logError(['daemon', 'controlplane'], 'Unsupported command type (dispatch pending)', {
            commandId: unknownCmd.commandId,
            type: unknownCmd.type,
          })
          ?.catch(() => {})
      }
    }
  }

  const connection =
    deps.createConnection?.({
      baseUrl: config.baseUrl,
      nodeId: config.nodeId,
      enrollmentToken: config.enrollmentToken,
      hostname: config.hostname,
      platform: config.platform,
      version: config.version,
      agentList: config.agentList,
      logger: config.logger,
      onCommand: executePolledCommand,
      onConnectionStateChange: config.onConnectionStateChange,
    }) ??
    new ControlPlaneConnection({
      baseUrl: config.baseUrl,
      nodeId: config.nodeId,
      enrollmentToken: config.enrollmentToken,
      hostname: config.hostname,
      platform: config.platform,
      version: config.version,
      agentList: config.agentList,
      logger: config.logger,
      onCommand: executePolledCommand,
      onConnectionStateChange: config.onConnectionStateChange,
    })

  currentConnection = connection

  const taskExecutor =
    deps.createTaskExecutor?.({
      onExecutionStateChange: updateExecutionState,
    }) ??
    new TaskExecutor({
      nodeId: config.nodeId,
      onExecutionStateChange: updateExecutionState,
      logger: config.logger,
      enterCorrelation: config.enterCorrelation,
      createRunner: async (command) => {
        const agentConfig = config.agentConfigs[command.payload.agentId]
        if (agentConfig === undefined) {
          throw new Error(`Agent config not found for agentId "${command.payload.agentId}"`)
        }

        const resolvedAgentType = resolveAgentType(agentConfig)
        const useInProcessRunner =
          resolvedAgentType === 'native' &&
          config.nativeAgentContext !== undefined &&
          config.defaultGraph !== undefined &&
          config.executorFactory !== undefined

        await config.logger?.logDebug(['daemon', 'task'], 'Resolved task runner type', {
          taskId: command.payload.taskId,
          agentId: command.payload.agentId,
          resolvedAgentType,
          hasNativeAgentContext: config.nativeAgentContext !== undefined,
          hasDefaultGraph: config.defaultGraph !== undefined,
          hasExecutorFactory: config.executorFactory !== undefined,
          runnerType: useInProcessRunner ? 'inprocess' : 'acp',
        })

        if (useInProcessRunner) {
          return new InProcessAgentRunner({
            agentId: command.payload.agentId,
            taskId: String(command.payload.taskId),
            emitEvent: config.emitTaskEvent,
            nativeAgentContext: config.nativeAgentContext,
            runtimeOptions: config.observerLogger ? { logger: config.observerLogger } : undefined,
            defaultGraph: config.defaultGraph,
            executorFactory: config.executorFactory,
          })
        }

        return new AgentRunner({
          agentId: command.payload.agentId,
          command: agentConfig.command,
          args: agentConfig.args,
          env: agentConfig.env,
          logger: config.logger,
        })
      },
      emitEvent: config.emitTaskEvent,
    } satisfies TaskExecutorConfig)

  taskExecutorRef = taskExecutor

  return {
    connection,
    taskExecutor,
    async onCommand(command: Command): Promise<void> {
      switch (command.type) {
        case 'task.run': {
          const taskId = String(command.payload.taskId)
          registry.register(taskId, taskExecutor)
          try {
            await taskExecutor.execute(command)
          } finally {
            registry.unregister(taskId)
          }
          break
        }
        case 'task.cancel': {
          registry.cancel(String(command.payload.taskId))
          break
        }
        default: {
          throw new Error(`Unknown command type: ${(command as { type: string }).type}`)
        }
      }
    },
  }
}
