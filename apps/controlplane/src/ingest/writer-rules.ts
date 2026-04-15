/**
 * 跨进程 ingest 的 writer 归属校验。不通过 → throw（L3 防线）。
 * @module ingest/writer-rules
 */

import type { DomainEventEnvelope, ProcessKind } from '@tianji/shared'

/** 断言条件为真，否则抛出带 "writer-rules:" 前缀的错误。 */
function ensure(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`writer-rules: ${msg}`)
}

/**
 * 校验事件信封的 source.processKind 是否符合该 aggregateType 的写入归属规则。
 *
 * 规则汇总：
 * - Session    → 仅 daemon
 * - GraphRun   → daemon 或 node
 * - Run        → daemon 或 node
 * - Task       → 仅 node（TaskObservationLost 例外：仅 cp）
 * - Node       → 仅 cp
 *
 * @throws {Error} 归属不合法时抛出，消息包含 "writer-rules:"
 */
export function validateWriter(env: DomainEventEnvelope): void {
  const kind: ProcessKind = env.source.processKind
  switch (env.aggregateType) {
    case 'Session':
      ensure(kind === 'daemon', `Session must be emitted by daemon, got ${kind}`)
      return
    case 'GraphRun':
    case 'Run':
      ensure(
        kind === 'daemon' || kind === 'node',
        `${env.aggregateType} must be emitted by daemon/node, got ${kind}`
      )
      return
    case 'Task':
      if (env.type === 'TaskObservationLost') {
        ensure(kind === 'cp', `TaskObservationLost must be emitted by cp, got ${kind}`)
      } else {
        ensure(kind === 'node', `Task ${env.type} must be emitted by node, got ${kind}`)
      }
      return
    case 'Node':
      ensure(kind === 'cp', `Node must be emitted by cp, got ${kind}`)
      return
  }
}
