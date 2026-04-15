/**
 * 根据 DomainEvent 推导 envelope 的 aggregateType 与 aggregateId。
 * 纯函数，无副作用，便于单测。
 * switch 覆盖全部 25 个事件类型；TypeScript strict 模式下遗漏会编译报错。
 * @module bus/event-target
 */

import type { AggregateType, DomainEvent } from '@tianji/shared'

export interface EventTarget {
  readonly aggregateType: AggregateType
  readonly aggregateId: string
}

/**
 * 从 DomainEvent 解析出对应聚合根标识。
 *
 * @param event - 裸领域事件
 * @returns 对应的 aggregateType 与 aggregateId
 */
export function resolveTarget(event: DomainEvent): EventTarget {
  switch (event.type) {
    case 'SessionCreated':
    case 'SessionResumed':
    case 'SessionClosed':
      return { aggregateType: 'Session', aggregateId: event.sessionId }

    case 'GraphRunStarted':
    case 'GraphRunCompleted':
    case 'GraphRunFailed':
    case 'GraphNodeStarted':
    case 'GraphNodeCompleted':
    case 'GraphNodeFailed':
      return { aggregateType: 'GraphRun', aggregateId: event.runId }

    case 'RunStarted':
    case 'RunCompleted':
    case 'RunFailed':
    case 'RunCancelled':
    case 'MessageStarted':
    case 'MessageDelta':
    case 'MessageCompleted':
    case 'ToolStarted':
    case 'ToolCompleted':
    case 'ToolFailed':
      return { aggregateType: 'Run', aggregateId: event.runId }

    case 'TaskStarted':
    case 'TaskWaiting':
    case 'TaskSessionAttached':
    case 'TaskCompleted':
    case 'TaskFailed':
    case 'TaskCancelled':
    case 'TaskObservationLost':
      return { aggregateType: 'Task', aggregateId: event.taskId }

    case 'NodeRegistered':
    case 'NodeReRegistered':
    case 'NodeMarkedOffline':
      return { aggregateType: 'Node', aggregateId: event.nodeId }
  }
}
