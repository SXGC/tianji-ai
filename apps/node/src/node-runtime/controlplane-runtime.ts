import type { LoadedAgentContext } from '@tianji/agent'
import type { ObserverLogger } from '@tianji/observer'
import type {
  AgentInfo,
  Command,
  NodeExecutionState,
  NodeId,
  PollCommandResponse,
  TianjiAgentConfig,
} from '@tianji/shared'

import { resolveAgentType } from '@tianji/shared'

import { AgentRunner, InProcessAgentRunner } from '../acp/index.js'
import { ControlPlaneConnection, type ControlPlaneConnectionConfig } from '../controlplane/index.js'
import type { RuntimeLogger } from '../logger.js'
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
}

export interface ControlPlaneCallbacks {
  onExecutionStateChange: (state: NodeExecutionState) => void
}

export interface ControlPlaneRuntimeDeps {
  createConnection?: (config: ControlPlaneConnectionConfig) => ControlPlaneConnectionLike
  createTaskExecutor?: (callbacks: ControlPlaneCallbacks) => TaskExecutorLike
}

export interface ControlPlaneConnectionLike {
  readonly client?: {
    openEventStream(taskId: string): Promise<{
      write(json: string): Promise<void>
      close(): Promise<void>
      abort(): void
      writeKeepalive(): Promise<void>
    }>
  }
  start(): Promise<void>
  stop(): void
  setExecutionState(state: NodeExecutionState): void
}

export interface TaskExecutorLike {
  readonly executionState: NodeExecutionState
  readonly currentTaskId: string | null
  execute(command: Command): Promise<void>
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

  const updateExecutionState = (state: NodeExecutionState): void => {
    currentConnection?.setExecutionState(state)
  }

  const toCommand = (command: PollCommandResponse): Command => ({
    commandId: command.commandId,
    nodeId: config.nodeId,
    type: command.type,
    payload: command.payload,
    state: 'pending',
    createdAt: Date.now(),
  })

  const executePolledCommand = (command: PollCommandResponse): void => {
    if (taskExecutorRef === null) {
      return
    }

    const taskCommand = toCommand(command)
    taskExecutorRef.execute(taskCommand).catch((error) => {
      config.logger
        ?.logError(['daemon', 'controlplane'], 'Failed to execute task command', {
          commandId: taskCommand.commandId,
          taskId: taskCommand.payload.taskId,
          agentId: taskCommand.payload.agentId,
          error: error instanceof Error ? error.message : String(error),
        })
        ?.catch(() => {})
    })
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
      createRunner: async (command) => {
        const agentConfig = config.agentConfigs[command.payload.agentId]
        if (agentConfig === undefined) {
          throw new Error(`Agent config not found for agentId "${command.payload.agentId}"`)
        }

        if (resolveAgentType(agentConfig) === 'native' && config.nativeAgentContext !== undefined) {
          return new InProcessAgentRunner({
            agentId: command.payload.agentId,
            nativeAgentContext: config.nativeAgentContext,
            runtimeOptions:
              config.observerLogger !== undefined ? { logger: config.observerLogger } : undefined,
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
      openEventStream: async (taskId) => {
        if (connection.client === undefined) {
          throw new Error('Control plane client is not available')
        }

        return connection.client.openEventStream(taskId)
      },
    } satisfies TaskExecutorConfig)

  taskExecutorRef = taskExecutor

  return {
    connection,
    taskExecutor,
    async onCommand(command: Command): Promise<void> {
      await taskExecutor.execute(command)
    },
  }
}
