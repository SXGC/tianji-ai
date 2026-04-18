import type {
  AgentExecutorFactory,
  LoadedAgentContext,
  OrchestrationGraph,
  UnifiedRuntimeEntry,
} from '@tianji/agent'
import { errorToLogData } from '@tianji/observer'
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
  createUnifiedEntry?: (command: TaskRunCommand) => Promise<UnifiedRuntimeEntry>
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

async function createControlPlaneUnifiedEntry(
  command: TaskRunCommand,
  config: ControlPlaneRuntimeConfig
): Promise<UnifiedRuntimeEntry> {
  const agentConfig = config.agentConfigs[command.payload.agentId]
  if (agentConfig === undefined) {
    throw new Error(`Agent config not found for agentId "${command.payload.agentId}"`)
  }

  if (
    config.nativeAgentContext === undefined ||
    config.defaultGraph === undefined ||
    config.executorFactory === undefined
  ) {
    throw new Error(
      'ControlPlaneRuntime requires nativeAgentContext, defaultGraph, and executorFactory for unified task execution'
    )
  }

  await config.logger?.logDebug(['daemon', 'task'], 'Preparing controlplane unified entry', {
    taskId: command.payload.taskId,
    agentId: command.payload.agentId,
    hasNativeAgentContext: true,
    hasDefaultGraph: true,
    hasExecutorFactory: true,
  })

  const sessionModule = await import('@tianji/agent')
  const nativeAgentContext = config.nativeAgentContext
  const built = await sessionModule.buildDefaultGraph(
    {
      source: 'controlplane',
      agentId: command.payload.agentId,
      input: command.payload.goal,
      sessionId: command.payload.sessionIds?.[0],
    },
    nativeAgentContext
  )
  const runtimeOptions = config.observerLogger ? { logger: config.observerLogger } : undefined
  let activeRun: {
    readonly runId: string
    readonly abort: () => void
  } | null = null

  return {
    run: async (request) => {
      const existingSessionId = command.payload.sessionIds?.[0]
      const session =
        existingSessionId !== undefined
          ? await sessionModule.ensureAgentSession(
              nativeAgentContext,
              existingSessionId,
              runtimeOptions
            )
          : await sessionModule.createAgentSession(nativeAgentContext, runtimeOptions)
      config.emitTaskEvent({
        type: 'TaskSessionAttached',
        taskId: String(command.payload.taskId),
        sessionId: session.sessionId,
        timestamp: Date.now(),
      })

      const events = session.queryWithGraph(built.graph, {
        initialState: { input: request.input },
        compileOptions: { agentExecutorFactory: built.executorFactory },
      })
      const iterator = events[Symbol.asyncIterator]()
      const first = await iterator.next()

      if (first.done) {
        throw new Error('ControlPlaneRuntime unified entry run ended before emitting any events')
      }

      const firstEvent = first.value
      if (!('runId' in firstEvent) || firstEvent.runId === undefined) {
        throw new Error('ControlPlaneRuntime unified entry run did not emit a runId')
      }

      const runId = String(firstEvent.runId)
      activeRun = {
        runId,
        abort: () => session.abort(),
      }

      async function* replayEvents(): AsyncIterable<typeof firstEvent> {
        try {
          yield firstEvent
          while (true) {
            const next = await iterator.next()
            if (next.done) {
              return
            }
            yield next.value
          }
        } finally {
          if (activeRun?.runId === runId) {
            activeRun = null
          }
        }
      }

      return {
        sessionId: session.sessionId,
        runId: firstEvent.runId,
        events: replayEvents(),
      }
    },
    resume: async () => {
      throw new Error('ControlPlaneRuntime unified entry resume is not implemented')
    },
    cancel: async ({ runId }) => {
      if (activeRun === null || activeRun.runId !== String(runId)) {
        throw new Error(
          `ControlPlaneRuntime unified entry cannot cancel unknown runId: ${String(runId)}`
        )
      }
      activeRun.abort()
    },
    stream: () => {
      throw new Error('ControlPlaneRuntime unified entry stream is not implemented')
    },
  }
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

  /**
   * 处理 long-poll 回调下发的命令（fire-and-forget 路径）。
   *
   * 此函数由 ControlPlaneConnection 的轮询循环异步调用，调用方不会 await 其结果，
   * 因此任何未捕获异常都会变成游离的 rejected Promise，无法向上传播。
   * 这条路径只能将错误落入日志——这不是"吞异常"的妥协，而是该分发模型的固有限制。
   *
   * 真正的 Let-it-crash 语义由 {@link ControlPlaneRuntimeHandle.onCommand} 承担：
   * 该路径是 await 调用，异常可以正常传播给调用方并触发上层重启/报警机制。
   */
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
            // fire-and-forget：日志 Promise 的 reject 也要吞掉，否则会变成 unhandledRejection。
            config.logger
              ?.logError(['daemon', 'controlplane'], 'Failed to execute task command', {
                commandId: taskCommand.commandId,
                taskId: taskCommand.payload.taskId,
                agentId: taskCommand.payload.agentId,
                error: errorToLogData(error),
              })
              ?.catch(() => {})
          })
          .finally(() => {
            registry.unregister(taskId)
          })
        break
      }
      case 'task.cancel': {
        // fire-and-forget 路径无法向上传播异常，只能记录日志；onCommand 路径直接 throw 实现 Let-it-crash。
        try {
          registry.cancel(String(command.payload.taskId))
        } catch (error) {
          // fire-and-forget：日志 Promise 的 reject 也要吞掉，否则会变成 unhandledRejection。
          config.logger
            ?.logError(['daemon', 'controlplane'], 'Failed to cancel task', {
              commandId: command.commandId,
              taskId: command.payload.taskId,
              error: errorToLogData(error),
            })
            ?.catch(() => {})
        }
        break
      }
      default: {
        // 穷尽断言：若 PollCommandResponse 新增 variant 而此处未处理，TS 编译期会在此行报错。
        const exhaustive: never = command
        const fallback = exhaustive as { commandId?: string; type?: string }
        // fire-and-forget：日志 Promise 的 reject 也要吞掉，否则会变成 unhandledRejection。
        config.logger
          ?.logError(['daemon', 'controlplane'], 'Unsupported command type (dispatch pending)', {
            commandId: fallback.commandId,
            type: fallback.type,
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
      createUnifiedEntry: async (command) =>
        deps.createUnifiedEntry?.(command) ?? createControlPlaneUnifiedEntry(command, config),
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
          // 穷尽断言：若 Command 新增 variant 而此处未处理，TS 编译期会在此行报错。
          const exhaustive: never = command
          throw new Error(`Unknown command type: ${(exhaustive as { type: string }).type}`)
        }
      }
    },
  }
}
