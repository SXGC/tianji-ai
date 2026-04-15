/**
 * 因果链上下文快照。不可变值对象。
 * 用于在一次用户 turn 内传播 correlationId/causationId。
 * @module bus/causal-context
 */

export class CausalContext {
  private constructor(
    public readonly correlationId: string,
    public readonly causationId: string | null
  ) {}

  /**
   * 创建根上下文。causationId 为 null，表示没有前置事件。
   *
   * @param correlationId - 本次用户 turn 的关联 ID
   */
  static root(correlationId: string): CausalContext {
    return new CausalContext(correlationId, null)
  }

  /**
   * 派生子上下文。继承 correlationId，causationId 指向触发当前操作的事件 ID。
   *
   * @param causationEventId - 触发本操作的父事件 eventId
   */
  child(causationEventId: string): CausalContext {
    return new CausalContext(this.correlationId, causationEventId)
  }
}
