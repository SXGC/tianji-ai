/**
 * 订阅 node bus，批量 POST envelope 到 cp。
 *
 * 设计要点：
 * - 订阅在 als.run() 之外建立，避免 ALS 上下文污染转发行为。
 * - 转发原始 envelope，不重写 correlationId/causationId（保留因果链完整性）。
 * - BatchCommitter 负责 maxItems 满或 flushIntervalMs 到时批量 POST。
 * - dispose() 顺序：unsubscribe → committer.dispose()（含 final flush）。
 *
 * @module bus/forwarder
 */

import type { ObserverLogger } from '@tianji/observer'
import type { DomainEventEnvelope, EventBus, SubscriptionHandle } from '@tianji/shared'
import { BatchCommitter } from '@tianji/shared'
import { buildEventDiagnosticFields, shouldLogEventDiagnostics } from '@tianji/shared'

/**
 * 仅转发 cp ingest writer-rules 会接受的 envelope。
 * 不改写 source，只在 node 侧提前拦掉必然会被 cp 拒绝的事件。
 */
function shouldForwardEnvelope(env: DomainEventEnvelope): boolean {
  const kind = env.source.processKind

  switch (env.aggregateType) {
    case 'Session':
      return kind === 'daemon'
    case 'GraphRun':
    case 'Run':
      return kind === 'daemon' || kind === 'node'
    case 'Task':
      if (env.type === 'TaskObservationLost') {
        return kind === 'cp'
      }
      return kind === 'node'
    case 'Node':
      return kind === 'cp'
  }
}

/** POST 函数签名：接受 envelope 数组，返回 Promise<void>。 */
export type ForwarderPost = (body: {
  events: readonly DomainEventEnvelope[]
}) => Promise<void>

/** createForwarder 依赖注入参数。 */
export interface ForwarderDeps {
  /** 进程内 EventBus，forwarder 在此订阅全量事件。 */
  readonly bus: EventBus
  /** 对 cp 的 HTTP POST 实现，由调用方注入（便于测试替换）。 */
  readonly post: ForwarderPost
  /** BatchCommitter 积累上限：达到时立即触发 flush。 */
  readonly maxItems: number
  /** BatchCommitter 定时 flush 间隔（毫秒）。 */
  readonly flushIntervalMs: number
  /**
   * 动态获取当前执行任务 ID 的 getter。
   * daemon 是长进程，每次执行不同任务；通过 getter 动态获取当前 taskId。
   * 返回 null 时事件跳过入队（无任务执行中，避免启动阶段背景噪音入缓冲区）。
   */
  readonly getCurrentTaskId: () => string | null
  readonly logger?: ObserverLogger
}

/** createForwarder 返回的句柄，含 subscription 与 dispose。 */
export interface ForwarderHandle {
  readonly subscription: SubscriptionHandle
  dispose(): Promise<void>
}

/**
 * 创建 cross-process forwarder：订阅 bus 全量事件，批量 POST 到 cp。
 *
 * @param deps - 注入依赖（bus、post、批量参数、taskId）
 * @returns ForwarderHandle（含 subscription + dispose）
 */
export function createForwarder(deps: ForwarderDeps): ForwarderHandle {
  const committer = new BatchCommitter<DomainEventEnvelope>({
    maxItems: deps.maxItems,
    flushIntervalMs: deps.flushIntervalMs,
    flush: async (events) => {
      await deps.post({ events })
    },
  })

  // 订阅在 als.run() 之外建立：不持有任何 ALS 上下文，envelope 原样转发
  const subscription = deps.bus.subscribe(
    {},
    (env) => {
      if (!shouldForwardEnvelope(env)) {
        return
      }
      if (deps.getCurrentTaskId() === null) {
        return
      }
      if (shouldLogEventDiagnostics(env)) {
        void deps.logger?.info(
          ['daemon', 'controlplane', 'forwarder'],
          'forwarding envelope to controlplane',
          buildEventDiagnosticFields(env)
        )
      }
      committer.push(env)
    },
    { name: 'cp-forwarder', queueSize: 10_000 }
  )

  return {
    subscription,
    async dispose(): Promise<void> {
      // 先 unsubscribe 阻止新 envelope 进入 committer，再 dispose 保证 final flush
      subscription.unsubscribe()
      await committer.dispose()
    },
  }
}
