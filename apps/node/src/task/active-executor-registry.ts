/**
 * 进程级活跃 TaskExecutor 注册表。
 *
 * @module task/active-executor-registry
 *
 * @remarks
 * ## 职责
 * 维护 `taskId → CancellableExecutor` 的映射，为 cancel 指令提供路由入口。
 * 上层 daemon 收到 `task.cancel` 命令时，通过此 registry 找到对应执行器并调用 cancel()。
 *
 * ## 为什么 register 冲突要抛错
 * 根据系统约束（spec §7.1），同一时刻每个 taskId 最多只有一个活跃 executor。
 * 若重复注册，说明上层状态机出错（未先 unregister），应立即暴露（Let it crash）。
 *
 * ## 为什么 cancel 找不到要抛错
 * 调用方在发送 cancel 前应先确认 task 处于活跃状态。
 * 找不到意味着 task 已结束或从未存在，继续静默会掩盖上层逻辑缺陷。
 *
 * ## 为什么 unregister 找不到静默返回
 * `unregister` 通常在 finally 块中调用，即使注册失败也会触发。
 * `Map.delete` 的语义本身幂等，无需抛错。
 */

/**
 * 可取消执行器的最小接口。
 *
 * TaskExecutor 在 Task 3.4 加入 cancel() 后自动满足此结构类型，无需显式 implements。
 */
export interface CancellableExecutor {
  cancel(): void
}

/**
 * 进程级 TaskExecutor 注册表，提供 register / unregister / cancel 三个操作。
 */
export class ActiveExecutorRegistry {
  readonly #executors = new Map<string, CancellableExecutor>()

  /**
   * 将 executor 注册到 taskId。
   *
   * @param taskId - 任务唯一标识
   * @param executor - 可取消的执行器实例
   * @throws 若 taskId 已被注册（重复注册说明上层状态机出错）
   */
  register(taskId: string, executor: CancellableExecutor): void {
    if (this.#executors.has(taskId)) {
      throw new Error(`TaskExecutor already registered for taskId=${taskId}`)
    }
    this.#executors.set(taskId, executor)
  }

  /**
   * 从注册表移除 taskId 对应的 executor。
   *
   * @param taskId - 任务唯一标识
   * @remarks 若 taskId 不存在则静默返回（finally 块幂等安全）
   */
  unregister(taskId: string): void {
    this.#executors.delete(taskId)
  }

  /**
   * 向指定 taskId 的 executor 发送取消信号。
   *
   * @param taskId - 任务唯一标识
   * @throws 若 taskId 对应的 executor 不存在
   */
  cancel(taskId: string): void {
    const executor = this.#executors.get(taskId)
    if (executor === undefined) {
      throw new Error(`TaskExecutor not found for taskId=${taskId}`)
    }
    executor.cancel()
  }
}
