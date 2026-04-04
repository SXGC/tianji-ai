import type { AgentInfo, Command, NodeExecutionState, NodeId } from '@tianji/shared'

import { AgentRunner } from '../acp/index.js'
import { ControlPlaneConnection, type ControlPlaneConnectionConfig } from '../controlplane/index.js'
import { TaskExecutor, type TaskExecutorConfig } from '../task/task-executor.js'

export interface ControlPlaneRuntimeConfig {
  readonly baseUrl: string
  readonly nodeId: NodeId
  readonly enrollmentToken: string
  readonly hostname: string
  readonly platform: string
  readonly version: string
  readonly agentList: readonly AgentInfo[]
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

  const connection =
    deps.createConnection?.({
      baseUrl: config.baseUrl,
      nodeId: config.nodeId,
      enrollmentToken: config.enrollmentToken,
      hostname: config.hostname,
      platform: config.platform,
      version: config.version,
      agentList: config.agentList,
      onCommand: (command) => {
        if (taskExecutorRef !== null) {
          void taskExecutorRef.execute(command as Command)
        }
      },
    }) ??
    new ControlPlaneConnection({
      baseUrl: config.baseUrl,
      nodeId: config.nodeId,
      enrollmentToken: config.enrollmentToken,
      hostname: config.hostname,
      platform: config.platform,
      version: config.version,
      agentList: config.agentList,
      onCommand: (command) => {
        if (taskExecutorRef !== null) {
          void taskExecutorRef.execute(command as Command)
        }
      },
    })

  currentConnection = connection

  const taskExecutor =
    deps.createTaskExecutor?.({
      onExecutionStateChange: updateExecutionState,
    }) ??
    new TaskExecutor({
      nodeId: config.nodeId,
      onExecutionStateChange: updateExecutionState,
      createRunner: async (command) => {
        return new AgentRunner({
          agentId: command.payload.agentId,
          binaryPath: process.env.TIANJI_AGENT_BIN ?? 'tianji-agent',
          args: parseAgentArgs(process.env.TIANJI_AGENT_ARGS),
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

function parseAgentArgs(raw: string | undefined): readonly string[] {
  if (!raw) {
    return []
  }

  return JSON.parse(raw) as string[]
}
