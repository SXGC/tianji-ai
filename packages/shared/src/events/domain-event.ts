/**
 * 聚合全部聚合领域事件的联合类型。
 * @module events/domain-event
 */

import type { GraphRunDomainEvent } from './graph-run.js'
import type { NodeDomainEvent } from './node.js'
import type { RunDomainEvent } from './run.js'
import type { SessionDomainEvent } from './session.js'
import type { TaskDomainEvent } from './task.js'

export type DomainEvent =
  | SessionDomainEvent
  | GraphRunDomainEvent
  | RunDomainEvent
  | TaskDomainEvent
  | NodeDomainEvent

export type DomainEventType = DomainEvent['type']
