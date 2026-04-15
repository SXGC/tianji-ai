import type { DomainEvent } from '@tianji/shared'

export interface IAgentRunner {
  readonly agentId: string
  connect(): Promise<void>
  query(prompt: string): AsyncIterable<DomainEvent>
  disconnect(): Promise<void>
}
