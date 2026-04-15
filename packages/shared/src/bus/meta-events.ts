/**
 * Bus 内部元事件（不进 event_log，避免循环）。
 * @module bus/meta-events
 */

export interface SubscriberLagNotice {
  readonly subscriberName: string
  readonly droppedEventId: string
  readonly droppedEventType: string
  readonly queueSize: number
  readonly occurredAt: string
}
