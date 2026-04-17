import type { DomainEvent } from '@tianji/shared'

/**
 * Legacy in-process runner shell.
 *
 * 原先它负责把 native agent 直接跑在 daemon 内部；Task 5 起这条主链迁到 unified entry。
 */
export class InProcessAgentRunner {
  readonly agentId: string

  constructor(config: {
    agentId: string
  }) {
    this.agentId = config.agentId
  }

  async connect(): Promise<void> {
    throw new Error(
      'InProcessAgentRunner can no longer be used as a mainline entry; use unified entry'
    )
  }

  /**
   * 通过 queryWithGraph 向 session 发送 prompt，产出 DomainEvent 流。
   *
   * disconnect() 触发时，session.abort() 中断 queryWithGraph，此时检测到 generation
   * 不匹配，立即产出 RunCancelled 事件后 return，让 TaskExecutor 能走 cancel 分支。
   *
   * @param prompt - 用户输入的文本
   */
  async *query(prompt: string): AsyncIterable<DomainEvent> {
    void prompt
    yield* []
    throw new Error(
      'InProcessAgentRunner can no longer be used as a mainline entry; use unified entry'
    )
  }

  async disconnect(): Promise<void> {
    return
  }
}
