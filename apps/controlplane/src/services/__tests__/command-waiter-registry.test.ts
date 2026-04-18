import { describe, expect, it } from 'vitest'

import { CommandWaiterRegistry } from '../command-waiter-registry.js'

describe('CommandWaiterRegistry', () => {
  it('should resolve true when waiter is notified', async () => {
    const registry = new CommandWaiterRegistry()
    const controller = new AbortController()
    const resultPromise = registry.wait('node-1', controller.signal)

    registry.notify('node-1')

    await expect(resultPromise).resolves.toBe(true)
  })

  it('should resolve false when waiter is aborted', async () => {
    const registry = new CommandWaiterRegistry()
    const controller = new AbortController()
    const resultPromise = registry.wait('node-1', controller.signal)

    controller.abort()

    await expect(resultPromise).resolves.toBe(false)
  })

  it('should notify all waiters of the same node id', async () => {
    const registry = new CommandWaiterRegistry()
    const controller1 = new AbortController()
    const controller2 = new AbortController()

    const waiter1 = registry.wait('node-1', controller1.signal)
    const waiter2 = registry.wait('node-1', controller2.signal)

    registry.notify('node-1')

    await expect(Promise.all([waiter1, waiter2])).resolves.toEqual([true, true])
  })

  it('should only wake waiters of the notified node id', async () => {
    const registry = new CommandWaiterRegistry()
    const controller1 = new AbortController()
    const controller2 = new AbortController()

    const waiter1 = registry.wait('node-1', controller1.signal)
    let node2Settled = false
    const waiter2 = registry.wait('node-2', controller2.signal).then((value) => {
      node2Settled = true
      return value
    })

    registry.notify('node-1')

    await expect(waiter1).resolves.toBe(true)
    await Promise.resolve()
    expect(node2Settled).toBe(false)

    controller2.abort()
    await expect(waiter2).resolves.toBe(false)
  })

  it('should not throw when notifying non-existent node id', () => {
    const registry = new CommandWaiterRegistry()

    expect(() => registry.notify('node-not-exists')).not.toThrow()
  })

  it('should resolve false for all pending waiters when destroyed', async () => {
    const registry = new CommandWaiterRegistry()
    const controller1 = new AbortController()
    const controller2 = new AbortController()

    const waiter1 = registry.wait('node-1', controller1.signal)
    const waiter2 = registry.wait('node-2', controller2.signal)

    registry.destroy()

    await expect(Promise.all([waiter1, waiter2])).resolves.toEqual([false, false])
  })

  it('should resolve false immediately when waiting after destroy', async () => {
    const registry = new CommandWaiterRegistry()
    registry.destroy()

    const controller = new AbortController()

    await expect(registry.wait('node-1', controller.signal)).resolves.toBe(false)
  })
})
