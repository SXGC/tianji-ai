/**
 * 因果链上下文访问接口与 AsyncLocalStorage 实现工厂。
 * 与 CausalContext 值对象分离，避免 envelope-wrapper ↔ pipeline 循环依赖。
 * @module bus/causal-context-provider
 */

import type { AsyncLocalStorage } from 'node:async_hooks'

import type { CausalContext } from './causal-context.js'

/**
 * 抽象因果链上下文访问接口。
 *
 * 可使用可变 ref（单请求/测试）或 AsyncLocalStorage（并发 run 隔离）实现。
 */
export interface CausalContextProvider {
  /** 读取当前上下文快照。 */
  getCurrent(): CausalContext
  /** 将上下文推进到下一个快照（publish 后调用）。 */
  update(next: CausalContext): void
}

/**
 * 基于 AsyncLocalStorage 创建 CausalContextProvider。
 *
 * als 的 store 是 `{ current: CausalContext }` 可变容器，
 * 保证每个 als.run() 上下文里的引用相互独立。
 *
 * @param als - 由装配层在 run 入口前创建的 AsyncLocalStorage 实例
 */
export function createAlsCausalContextProvider(
  als: AsyncLocalStorage<{ current: CausalContext }>
): CausalContextProvider {
  return {
    getCurrent(): CausalContext {
      const store = als.getStore()
      if (store === undefined) {
        throw new Error(
          '[pipeline] CausalContext not found in AsyncLocalStorage. ' +
            'Ensure emitEvent is called inside als.run().'
        )
      }
      return store.current
    },
    update(next: CausalContext): void {
      const store = als.getStore()
      if (store === undefined) {
        throw new Error(
          '[pipeline] CausalContext not found in AsyncLocalStorage. ' +
            'Ensure emitEvent is called inside als.run().'
        )
      }
      store.current = next
    },
  }
}
