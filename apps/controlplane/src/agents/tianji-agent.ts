/**
 * TianjiAgent - AG-UI 兼容的代理适配器
 *
 * 将 ControlPlane 的任务/事件服务桥接到 AG-UI AbstractAgent 接口。
 * 通过创建 command + task 记录触发节点执行，然后轮询事件流并转换为 AG-UI 事件推送给调用方。
 *
 * @module tianji-agent
 */
import { randomUUID } from 'node:crypto'
import { AbstractAgent } from '@ag-ui/client'
import type { BaseEvent, RunAgentInput } from '@ag-ui/client'
import { Observable } from 'rxjs'
import type { ControlPlaneDb } from '../db/index.js'
import { EventStore } from '../services/event-store.js'
import {
  type EventMapperContext,
  createInitialStateSnapshot,
  mapTaskEventToAgUiEvents,
} from './event-mapper.js'

const POLL_INTERVAL_MS = 500
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

/**
 * TianjiAgent 将远程节点上的任务执行封装为 AG-UI 兼容的 Observable 事件流。
 *
 * 执行流程：
 * 1. 从用户消息中提取 goal
 * 2. 在数据库中插入 command 和 task 记录
 * 3. 轮询 task_events 表，将事件映射为 AG-UI BaseEvent 并推送给订阅者
 * 4. 任务进入终态后完成 Observable
 */
export class TianjiAgent extends AbstractAgent {
  readonly #db: ControlPlaneDb
  readonly #nodeId: string
  /** ControlPlane 内部 agentId，避免与 AbstractAgent.agentId 冲突 */
  readonly #cpAgentId: string

  /**
   * @param db       - ControlPlane 数据库实例
   * @param nodeId   - 目标执行节点 ID
   * @param agentId  - ControlPlane 内部代理 ID
   */
  constructor(db: ControlPlaneDb, nodeId: string, agentId: string) {
    super({ description: `Tianji agent for node ${nodeId}` })
    this.#db = db
    this.#nodeId = nodeId
    this.#cpAgentId = agentId
  }

  /**
   * 执行一次代理运行，返回 AG-UI 事件流。
   *
   * 订阅方取消订阅时，轮询循环会自动终止。
   *
   * @param input - AG-UI 运行输入，包含消息历史和上下文
   * @returns AG-UI BaseEvent 的 Observable 流
   */
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let aborted = false

      const execute = async (): Promise<void> => {
        try {
          // 从最后一条用户消息中提取 goal
          const lastUserMsg = [...input.messages].reverse().find((m) => m.role === 'user')
          const rawContent = lastUserMsg?.content ?? ''
          const goalText = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)

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

          // 推送初始状态快照
          subscriber.next(createInitialStateSnapshot())

          // 轮询事件流
          const eventStore = new EventStore(this.#db)
          const ctx: EventMapperContext = { inThinking: false, taskId }
          let lastSequence = 0
          let hasTextMessage = false

          while (!aborted) {
            const events = eventStore.getEvents(taskId, lastSequence, 1000)

            for (const event of events) {
              const agUiEvents = mapTaskEventToAgUiEvents(event, ctx)
              for (const e of agUiEvents) {
                subscriber.next(e)
                if (e.type === 'TEXT_MESSAGE_START') hasTextMessage = true
              }
              lastSequence = event.sequence
            }

            // 检查任务终态
            const row = this.#db.raw
              .prepare('SELECT status FROM tasks WHERE task_id = ?')
              .get(taskId) as { status: string } | undefined
            const status = row?.status ?? 'pending'

            if (TERMINAL_STATUSES.has(status)) {
              // 终态后再读取一次，确保不遗漏最后的事件
              const remaining = eventStore.getEvents(taskId, lastSequence, 1000)
              for (const event of remaining) {
                const agUiEvents = mapTaskEventToAgUiEvents(event, ctx)
                for (const e of agUiEvents) {
                  subscriber.next(e)
                  if (e.type === 'TEXT_MESSAGE_START') hasTextMessage = true
                }
                lastSequence = event.sequence
              }

              // completed 状态且没有文本消息时，发送兜底提示
              if (!hasTextMessage && status === 'completed') {
                const fbMsgId = `fallback-${taskId}`
                subscriber.next({
                  type: 'TEXT_MESSAGE_START',
                  messageId: fbMsgId,
                  role: 'assistant',
                } as BaseEvent)
                subscriber.next({
                  type: 'TEXT_MESSAGE_CONTENT',
                  messageId: fbMsgId,
                  delta: '任务已完成',
                } as BaseEvent)
                subscriber.next({ type: 'TEXT_MESSAGE_END', messageId: fbMsgId } as BaseEvent)
              }

              subscriber.complete()
              return
            }

            // 等待下次轮询
            await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
          }
        } catch (err) {
          subscriber.error(err)
        }
      }

      void execute()

      // 取消订阅时停止轮询循环
      return () => {
        aborted = true
      }
    })
  }
}
