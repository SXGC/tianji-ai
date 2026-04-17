import { describe, expect, it, vi } from 'vitest'

import { ActiveExecutorRegistry } from '../active-executor-registry.js'
import type { TaskExecutor } from '../task-executor.js'

describe('ActiveExecutorRegistry', () => {
  it('register 后可通过 taskId 路由 cancel', () => {
    const registry = new ActiveExecutorRegistry()
    const executor = { cancel: vi.fn() } as unknown as TaskExecutor
    registry.register('t1', executor)
    registry.cancel('t1')
    expect(executor.cancel).toHaveBeenCalledOnce()
  })

  it('unregister 后 cancel 抛错（Let it crash）', () => {
    const registry = new ActiveExecutorRegistry()
    const executor = { cancel: vi.fn() } as unknown as TaskExecutor
    registry.register('t1', executor)
    registry.unregister('t1')
    expect(() => registry.cancel('t1')).toThrow(/not found/i)
  })

  it('同一 taskId 重复 register 抛错', () => {
    const registry = new ActiveExecutorRegistry()
    const e1 = { cancel: vi.fn() } as unknown as TaskExecutor
    const e2 = { cancel: vi.fn() } as unknown as TaskExecutor
    registry.register('t1', e1)
    expect(() => registry.register('t1', e2)).toThrow(/already/i)
  })

  it('cancel 不存在的 taskId 抛错', () => {
    const registry = new ActiveExecutorRegistry()
    expect(() => registry.cancel('t1')).toThrow(/not found/i)
  })

  it('unregister 不存在的 taskId 静默返回', () => {
    const registry = new ActiveExecutorRegistry()
    // 不应抛错，finally 块在注册失败后也可能调用 unregister
    expect(() => registry.unregister('t1')).not.toThrow()
  })
})
