/**
 * Legacy ACP runner shell.
 *
 * Task 5 起，ACP 不再是 node 主链入口；保留这个类只是为了让遗留调用点显式失败。
 *
 * @module acp/agent-runner
 */

import type { DomainEvent } from '@tianji/shared'

import type { RuntimeLogger } from '../logger.js'

export interface AgentRunnerConfig {
  readonly agentId: string
  /** 可执行命令，默认 tianji-agent */
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
  readonly logger?: RuntimeLogger
}

export class AgentRunner {
  readonly agentId: string
  readonly #config: AgentRunnerConfig

  constructor(config: AgentRunnerConfig) {
    this.agentId = config.agentId
    this.#config = config
  }

  async connect(): Promise<void> {
    throw new Error('AgentRunner can no longer be used as a mainline entry; use unified entry')
  }

  async *query(_prompt: string): AsyncIterable<DomainEvent> {
    yield* []
    throw new Error('AgentRunner can no longer be used as a mainline entry; use unified entry')
  }

  async disconnect(): Promise<void> {
    await this.#config.logger?.logDebug(
      ['acp', 'runner'],
      'Ignoring disconnect for legacy runner shell',
      {
        agentId: this.#config.agentId,
      }
    )
  }
}
