/**
 * 按 aggregateType 区分 envelope 的类型守卫。
 * @module events/guards
 */

import type { DomainEventEnvelope } from './envelope.js'
import type { GraphRunDomainEvent } from './graph-run.js'
import type { NodeDomainEvent } from './node.js'
import type { RunDomainEvent } from './run.js'
import type { SessionDomainEvent } from './session.js'
import type { TaskDomainEvent } from './task.js'

export function isSessionEvent(
  env: DomainEventEnvelope
): env is DomainEventEnvelope<SessionDomainEvent> {
  return env.aggregateType === 'Session'
}

export function isGraphRunEvent(
  env: DomainEventEnvelope
): env is DomainEventEnvelope<GraphRunDomainEvent> {
  return env.aggregateType === 'GraphRun'
}

export function isRunEvent(env: DomainEventEnvelope): env is DomainEventEnvelope<RunDomainEvent> {
  return env.aggregateType === 'Run'
}

export function isTaskEvent(env: DomainEventEnvelope): env is DomainEventEnvelope<TaskDomainEvent> {
  return env.aggregateType === 'Task'
}

export function isNodeEvent(env: DomainEventEnvelope): env is DomainEventEnvelope<NodeDomainEvent> {
  return env.aggregateType === 'Node'
}
