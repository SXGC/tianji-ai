import type { DomainEventEnvelope } from './events/index.js'

/**
 * 仅对关键事件输出诊断日志，避免 MessageDelta 刷屏。
 */
export function shouldLogEventDiagnostics(env: DomainEventEnvelope): boolean {
  return env.type !== 'MessageDelta' && env.type !== 'TaskMessageDelta'
}

/**
 * 提取跨层对账需要的最小字段。
 */
export function buildEventDiagnosticFields(env: DomainEventEnvelope): Record<string, unknown> {
  return {
    eventId: env.eventId,
    eventType: env.type,
    aggregateType: env.aggregateType,
    aggregateId: env.aggregateId,
    sequence: env.sequence,
    correlationId: env.correlationId,
    causationId: env.causationId,
    processKind: env.source.processKind,
    processId: env.source.processId,
    nodeId: env.source.nodeId,
  }
}
