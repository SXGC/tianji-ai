import type { RuntimeEvent } from '@tianji/shared'

export interface IAgentRunner {
  readonly agentId: string
  connect(): Promise<void>
  query(prompt: string): AsyncIterable<RuntimeEvent>
  disconnect(): Promise<void>
}
