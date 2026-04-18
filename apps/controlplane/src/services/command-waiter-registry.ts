type Waiter = {
  resolve: (value: boolean) => void
}

/**
 * 进程内的 command waiter 注册表。
 * 仅负责 wait/notify 通知，不承载 command 数据。
 */
export class CommandWaiterRegistry {
  readonly #waitersByNodeId = new Map<string, Set<Waiter>>()
  #destroyed = false

  /**
   * 等待指定 nodeId 的通知信号。
   * @param nodeId - 目标节点 ID
   * @param signal - 中止信号
   * @returns 收到 notify 时为 true；被中止或销毁时为 false
   */
  wait(nodeId: string, signal: AbortSignal): Promise<boolean> {
    if (this.#destroyed || signal.aborted) {
      return Promise.resolve(false)
    }

    return new Promise<boolean>((resolve) => {
      let settled = false
      const waiters = this.#waitersByNodeId.get(nodeId) ?? new Set<Waiter>()
      if (!this.#waitersByNodeId.has(nodeId)) {
        this.#waitersByNodeId.set(nodeId, waiters)
      }

      const settle = (value: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(value)
      }

      const onAbort = (): void => {
        settle(false)
      }

      const waiter: Waiter = {
        resolve: (value: boolean) => {
          settle(value)
        },
      }

      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort)
        waiters.delete(waiter)
        if (waiters.size === 0) {
          this.#waitersByNodeId.delete(nodeId)
        }
      }

      signal.addEventListener('abort', onAbort, { once: true })
      waiters.add(waiter)
    })
  }

  /**
   * 通知指定 nodeId 的全部 waiter。
   * @param nodeId - 目标节点 ID
   */
  notify(nodeId: string): void {
    const waiters = this.#waitersByNodeId.get(nodeId)
    if (waiters === undefined) {
      return
    }

    for (const waiter of Array.from(waiters)) {
      waiter.resolve(true)
    }
  }

  /**
   * 销毁注册表并唤醒所有 waiter，后续 wait 会立即返回 false。
   */
  destroy(): void {
    if (this.#destroyed) {
      return
    }
    this.#destroyed = true

    for (const waiters of this.#waitersByNodeId.values()) {
      for (const waiter of Array.from(waiters)) {
        waiter.resolve(false)
      }
    }
    this.#waitersByNodeId.clear()
  }
}
