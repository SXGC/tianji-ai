import type { DomainEventEnvelope } from '@tianji/shared'

export interface IAgentRunner {
  readonly agentId: string
  connect(): Promise<void>
  query(prompt: string): AsyncIterable<DomainEventEnvelope>
  disconnect(): Promise<void>
}
