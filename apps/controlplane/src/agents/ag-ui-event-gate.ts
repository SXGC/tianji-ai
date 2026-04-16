/**
 * AgUiEventGate - AG-UI 事件出口闸门
 *
 * 观察 AG-UI 事件类型自行维护活跃 messageId 集合；终态事件发出前 flush
 * 所有活跃消息；作为协议层保险网，让 event-mapper 保持纯函数。
 *
 * @module ag-ui-event-gate
 */
import { EventType } from '@ag-ui/client'
import type { BaseEvent } from '@ag-ui/client'
import type { ObserverLogger } from '@tianji/observer'

export interface AgUiGateSubscriber {
  next(event: BaseEvent): void
}

export interface AgUiEventGateContext {
  runId: string
  threadId: string
}

const SCOPE_AG_UI_GATE = ['controlplane', 'agents', 'ag-ui-gate'] as const

interface ActiveEntry {
  inThinking: boolean
  hasText: boolean
}

export class AgUiEventGate {
  readonly #subscriber: AgUiGateSubscriber
  readonly #context: AgUiEventGateContext
  readonly #logger: ObserverLogger
  readonly #active = new Map<string, ActiveEntry>()
  #terminated = false
  #disposed = false

  constructor(
    subscriber: AgUiGateSubscriber,
    context: AgUiEventGateContext,
    logger: ObserverLogger
  ) {
    this.#subscriber = subscriber
    this.#context = context
    this.#logger = logger
  }

  alreadyTerminated(): boolean {
    return this.#terminated
  }

  emit(event: BaseEvent): void {
    if (this.#terminated) {
      void this.#logger.warn(SCOPE_AG_UI_GATE, 'emit after terminal, ignored', {
        runId: this.#context.runId,
        threadId: this.#context.threadId,
        eventType: event.type,
      })
      return
    }

    this.#trackEvent(event)
    this.#subscriber.next(event)
  }

  #trackEvent(event: BaseEvent): void {
    // gate 入参保持 BaseEvent 兼容，避免和 event-mapper 的 union 类型强耦合
    const e = event as BaseEvent & { messageId?: string }
    const mid = typeof e.messageId === 'string' ? e.messageId : undefined
    if (mid === undefined) return

    switch (event.type) {
      case EventType.TEXT_MESSAGE_START: {
        const entry = this.#active.get(mid)
        if (entry !== undefined) entry.hasText = true
        else this.#active.set(mid, { inThinking: false, hasText: true })
        return
      }
      case EventType.REASONING_START: {
        const entry = this.#active.get(mid)
        if (entry !== undefined) entry.inThinking = true
        else this.#active.set(mid, { inThinking: true, hasText: false })
        return
      }
      case EventType.REASONING_END: {
        const entry = this.#active.get(mid)
        if (entry !== undefined) entry.inThinking = false
        return
      }
      case EventType.TEXT_MESSAGE_END:
        // 依赖 event-mapper 保证 REASONING 在 TEXT_MESSAGE_END 前已闭合
        this.#active.delete(mid)
        return
      default:
        return
    }
  }

  emitTerminal(event: BaseEvent): void {
    if (this.#terminated) {
      void this.#logger.warn(SCOPE_AG_UI_GATE, 'emitTerminal called more than once, ignored', {
        runId: this.#context.runId,
        threadId: this.#context.threadId,
        eventType: event.type,
      })
      return
    }

    if (this.#active.size > 0) {
      this.#flushActive('terminal')
    }

    this.#subscriber.next(event)
    this.#terminated = true
  }

  #flushActive(reason: 'terminal' | 'dispose'): void {
    const leakedIds: string[] = []
    const leakedState: Record<string, { inThinking: boolean; hasText: boolean }> = {}

    for (const [messageId, entry] of this.#active) {
      leakedIds.push(messageId)
      leakedState[messageId] = { inThinking: entry.inThinking, hasText: entry.hasText }

      if (entry.inThinking) {
        this.#subscriber.next({ type: EventType.REASONING_MESSAGE_END, messageId } as BaseEvent)
        this.#subscriber.next({ type: EventType.REASONING_END, messageId } as BaseEvent)
      }
      if (entry.hasText) {
        this.#subscriber.next({ type: EventType.TEXT_MESSAGE_END, messageId } as BaseEvent)
      }
    }
    this.#active.clear()

    void this.#logger.error(
      SCOPE_AG_UI_GATE,
      reason === 'terminal'
        ? 'active text messages on terminal, flushed'
        : 'active text messages on dispose without terminal, flushed',
      {
        runId: this.#context.runId,
        threadId: this.#context.threadId,
        messageIds: leakedIds,
        leakedState,
      }
    )
  }

  dispose(): void {
    throw new Error('Not implemented')
  }
}

export function isTerminalAgUiEvent(event: BaseEvent): boolean {
  return event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR
}
