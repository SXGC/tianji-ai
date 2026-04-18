/**
 * TianjiAgent - AG-UI 兼容的代理适配器
 *
 * 将 ControlPlane 的任务/事件服务桥接到 AG-UI AbstractAgent 接口。
 * 通过创建 command + task 记录触发节点执行，然后订阅 EventBus 并
 * 将 DomainEventEnvelope 转换为 AG-UI 事件推送给调用方。
 *
 * @module tianji-agent
 */
import { randomUUID } from 'node:crypto'
import { AbstractAgent, EventType } from '@ag-ui/client'
import type { BaseEvent, RunAgentInput } from '@ag-ui/client'
import type { ObserverLogger } from '@tianji/observer'
import type { EventBus, SubscriptionHandle } from '@tianji/shared'
import { Observable } from 'rxjs'
import type { ControlPlaneDb } from '../db/index.js'
import type { CommandWaiterRegistry } from '../services/command-waiter-registry.js'
import { AgUiEventGate, isTerminalAgUiEvent } from './ag-ui-event-gate.js'
import { type EventMapperContext, createInitialStateSnapshot, mapToAgUi } from './event-mapper.js'

/** Task 终态事件类型集合 */
const TERMINAL_TASK_TYPES = new Set([
  'TaskCompleted',
  'TaskFailed',
  'TaskCancelled',
  'TaskObservationLost',
])

/**
 * TianjiAgent 将远程节点上的任务执行封装为 AG-UI 兼容的 Observable 事件流。
 *
 * 执行流程：
 * 1. 从用户消息中提取 goal
 * 2. 在数据库中插入 command 和 task 记录
 * 3. 订阅 EventBus，将 DomainEventEnvelope 映射为 AG-UI BaseEvent 并推送给订阅者
 * 4. 任务进入终态后完成 Observable
 */
export class TianjiAgent extends AbstractAgent {
  readonly #db: ControlPlaneDb
  readonly #nodeId: string
  /** ControlPlane 内部 agentId，避免与 AbstractAgent.agentId 冲突 */
  readonly #cpAgentId: string
  readonly #bus: EventBus | undefined
  readonly #logger: ObserverLogger
  readonly #registry: CommandWaiterRegistry | undefined

  /**
   * @param db       - ControlPlane 数据库实例
   * @param nodeId   - 目标执行节点 ID
   * @param agentId  - ControlPlane 内部代理 ID
   * @param bus      - 进程内 EventBus 实例（未提供时 run() 订阅阶段会 crash）
   * @param logger   - 结构化日志，用于 AgUiEventGate 的泄漏与异常上报（必传）
   */
  constructor(
    db: ControlPlaneDb,
    nodeId: string,
    agentId: string,
    bus: EventBus | undefined,
    logger: ObserverLogger,
    registry?: CommandWaiterRegistry
  ) {
    super({ description: `Tianji agent for node ${nodeId}` })
    this.#db = db
    this.#nodeId = nodeId
    this.#cpAgentId = agentId
    this.#bus = bus
    this.#logger = logger
    this.#registry = registry
  }

  /**
   * 执行一次代理运行，返回 AG-UI 事件流。
   *
   * 取消订阅时，bus 订阅自动解除。
   *
   * @param input - AG-UI 运行输入，包含消息历史和上下文
   * @returns AG-UI BaseEvent 的 Observable 流
   */
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const runId = input.runId ?? randomUUID()
      const threadId = input.threadId ?? this.#nodeId

      subscriber.next({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent)
      // AG-UI 运行流要求首个事件必须是 RUN_STARTED，快照放在其后。
      subscriber.next(createInitialStateSnapshot())

      // 从最后一条用户消息中提取 goal
      const lastUserMsg = [...input.messages].reverse().find((m) => m.role === 'user')
      const goalText = extractUserMessageText(lastUserMsg?.content)

      // 校验节点存在且在线
      const node = this.#db.raw
        .prepare('SELECT status FROM nodes WHERE node_id = ?')
        .get(this.#nodeId) as { status: string } | undefined

      if (node === undefined) {
        subscriber.next({ type: EventType.RUN_ERROR, message: 'Node not found' } as BaseEvent)
        subscriber.complete()
        return
      }
      if (node.status === 'offline') {
        subscriber.next({ type: EventType.RUN_ERROR, message: 'Node is offline' } as BaseEvent)
        subscriber.complete()
        return
      }

      // 创建 command 和 task 记录
      const now = Date.now()
      const taskId = randomUUID()
      const commandId = randomUUID()
      const payload = JSON.stringify({
        taskId,
        agentId: this.#cpAgentId,
        goal: goalText,
        sessionIds: [],
      })

      this.#db.raw
        .prepare(
          'INSERT INTO commands (command_id, node_id, type, payload, state, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(commandId, this.#nodeId, 'task.run', payload, 'pending', now)

      this.#db.raw
        .prepare(
          'INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(taskId, commandId, this.#nodeId, this.#cpAgentId, goalText, 'pending', now, now)
      this.#registry?.notify(this.#nodeId)

      // 订阅 EventBus，消费与此 task 相关的事件
      const ctx: EventMapperContext = { inThinking: false, taskId }
      let hasTextMessage = false
      // gate 作为协议层闸门：所有 AG-UI 事件必须走 gate.emit / gate.emitTerminal，
      // 终态前自动 flush 未闭合的 TEXT/REASONING，防止 "active text messages" 协议错。
      const gate = new AgUiEventGate(subscriber, { runId, threadId }, this.#logger)

      // bus 未注入时会在此处 crash（Let it crash，装配层职责）
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const subscription: SubscriptionHandle = this.#bus!.subscribe(
        { aggregateId: taskId },
        (env) => {
          const frames = mapToAgUi(env, ctx)
          for (const f of frames) {
            if (isTerminalAgUiEvent(f)) gate.emitTerminal(f)
            else gate.emit(f)
            if (f.type === EventType.TEXT_MESSAGE_START) hasTextMessage = true
          }

          // 任务终态事件触发流结束
          if (TERMINAL_TASK_TYPES.has(env.type)) {
            // completed 状态且没有文本消息时，发送兜底提示
            if (!hasTextMessage && env.type === 'TaskCompleted') {
              const fbMsgId = `fallback-${taskId}`
              gate.emit({
                type: EventType.TEXT_MESSAGE_START,
                messageId: fbMsgId,
                role: 'assistant',
              } as BaseEvent)
              gate.emit({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: fbMsgId,
                delta: '任务已完成',
              } as BaseEvent)
              gate.emit({ type: EventType.TEXT_MESSAGE_END, messageId: fbMsgId } as BaseEvent)
            }

            if (!gate.alreadyTerminated()) {
              // TaskCompleted 和 TaskCancelled 都是优雅结束，发 RUN_FINISHED。
              // cancel 携带 reason='cancelled' 以便客户端区分。
              // 其他终态（TaskFailed、TaskObservationLost）视为错误，发 RUN_ERROR。
              if (env.type === 'TaskCompleted' || env.type === 'TaskCancelled') {
                gate.emitTerminal({
                  type: EventType.RUN_FINISHED,
                  threadId,
                  runId,
                  ...(env.type === 'TaskCancelled' ? { reason: 'cancelled' } : {}),
                } as BaseEvent)
              } else {
                gate.emitTerminal({
                  type: EventType.RUN_ERROR,
                  message: `Task ${env.type}`,
                } as BaseEvent)
              }
            }

            subscription.unsubscribe()
            gate.dispose()
            subscriber.complete()
          }
        },
        { name: 'ag-ui-adapter', queueSize: 10_000 }
      )

      // 取消订阅时解除 bus 订阅并 dispose gate
      return () => {
        subscription.unsubscribe()
        gate.dispose()
      }
    })
  }

  /**
   * 发起取消某个 task 的请求。
   *
   * 向 commands 表插入一条 task.cancel 命令，node daemon 在下一轮 long-poll 时拉到，
   * 通过 ActiveExecutorRegistry 路由到运行中的 TaskExecutor 并触发其 cancel。
   *
   * @remarks
   * nodeId 从 tasks 表反查而非使用 this.#nodeId，因为 cancel 路由可能由任意 agent
   * 实例发起，而真正持有 task 的 node 可能不同。
   *
   * @param taskId - 要取消的任务 ID
   * @throws 若 taskId 在 tasks 表不存在（Let it crash，上层应已做存在性校验）
   */
  async cancelTask(taskId: string): Promise<void> {
    const task = this.#db.raw.prepare('SELECT node_id FROM tasks WHERE task_id = ?').get(taskId) as
      | { node_id: string }
      | undefined

    if (task === undefined) {
      throw new Error(`Task not found: ${taskId}`)
    }

    const commandId = randomUUID()
    const payload = JSON.stringify({ taskId, reason: 'user' })
    this.#db.raw
      .prepare(
        'INSERT INTO commands (command_id, node_id, type, payload, state, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(commandId, task.node_id, 'task.cancel', payload, 'pending', Date.now())
    this.#registry?.notify(task.node_id)
  }

  clone(): TianjiAgent {
    return new TianjiAgent(
      this.#db,
      this.#nodeId,
      this.#cpAgentId,
      this.#bus,
      this.#logger,
      this.#registry
    )
  }
}

function extractUserMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  const textParts = content
    .filter((part): part is { type: 'text'; text: string } => {
      return (
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string'
      )
    })
    .map((part) => part.text)

  return textParts.join('\n')
}
