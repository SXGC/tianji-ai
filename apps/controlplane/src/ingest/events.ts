/**
 * 跨进程 ingest：校验 + publish 到 cp bus。
 * 落盘由 cp bus 的 event-log-subscriber 接手，保持单一路径。
 * @module ingest/events
 */

import type { ObserverLogger } from '@tianji/observer'
import type { DomainEventEnvelope } from '@tianji/shared'

import { buildEventDiagnosticFields, shouldLogEventDiagnostics } from '@tianji/shared'
import { validateWriter } from './writer-rules.js'

export interface EventIngestDeps {
  readonly publish: (env: DomainEventEnvelope) => void
  readonly logger?: ObserverLogger
}

export interface EventIngest {
  ingest(env: DomainEventEnvelope): Promise<void>
}

/**
 * 创建 ingest 实例。接受来自外部进程的事件信封，
 * 先通过 validateWriter 校验写入归属，通过后 publish 到 cp bus。
 *
 * @throws {Error} 归属校验失败时直接抛出（Let it crash，不做降级）
 */
export function createEventIngest(deps: EventIngestDeps): EventIngest {
  return {
    async ingest(env) {
      if (shouldLogEventDiagnostics(env)) {
        void deps.logger?.info(
          ['cp', 'ingest'],
          'accepted envelope for cp ingest',
          buildEventDiagnosticFields(env)
        )
      }
      validateWriter(env)
      deps.publish(env)
    },
  }
}
