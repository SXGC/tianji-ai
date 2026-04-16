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

  emit(_event: BaseEvent): void {
    throw new Error('Not implemented')
  }

  emitTerminal(_event: BaseEvent): void {
    throw new Error('Not implemented')
  }

  dispose(): void {
    throw new Error('Not implemented')
  }
}

export function isTerminalAgUiEvent(event: BaseEvent): boolean {
  return event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR
}
