/**
 * Node 聚合领域事件。writer 为 cp registry。
 * @module events/node
 */

interface NodeFields {
  readonly nodeId: string
  readonly timestamp: number
}

export interface NodeRegisteredEvent extends NodeFields {
  readonly type: 'NodeRegistered'
  readonly version: string
}

export interface NodeReRegisteredEvent extends NodeFields {
  readonly type: 'NodeReRegistered'
  readonly version: string
}

export interface NodeMarkedOfflineEvent extends NodeFields {
  readonly type: 'NodeMarkedOffline'
  readonly reason: string
}

export type NodeDomainEvent = NodeRegisteredEvent | NodeReRegisteredEvent | NodeMarkedOfflineEvent
