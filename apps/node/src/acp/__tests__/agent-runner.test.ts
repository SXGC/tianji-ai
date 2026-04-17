import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DomainEvent } from '@tianji/shared'

// vi.mock 工厂内不能引用顶层变量（会被 hoist），改用 vi.hoisted 提升共享状态
const mocks = vi.hoisted(() => {
  const promptFn = vi.fn()
  const initializeFn = vi.fn()
  const newSessionFn = vi.fn()
  const spawnFn = vi.fn()
  const killFn = vi.fn()
  const onSessionUpdateFn = vi.fn()

  let capturedSessionUpdateHandler: ((update: unknown) => void) | null = null

  return {
    promptFn,
    initializeFn,
    newSessionFn,
    spawnFn,
    killFn,
    onSessionUpdateFn,
    get capturedSessionUpdateHandler() {
      return capturedSessionUpdateHandler
    },
    set capturedSessionUpdateHandler(v: ((update: unknown) => void) | null) {
      capturedSessionUpdateHandler = v
    },
  }
})

vi.mock('@agentclientprotocol/sdk', () => ({
  ClientSideConnection: vi.fn().mockImplementation(() => ({
    prompt: mocks.promptFn,
    initialize: mocks.initializeFn,
    newSession: mocks.newSessionFn,
  })),
  ndJsonStream: vi.fn().mockReturnValue({}),
}))

vi.mock('../agent-process.js', () => ({
  AgentProcessManager: vi.fn().mockImplementation(() => ({
    spawn: mocks.spawnFn,
    kill: mocks.killFn,
  })),
}))

vi.mock('../client-bridge.js', () => ({
  AcpNodeClient: vi.fn().mockImplementation(() => ({
    onSessionUpdate: mocks.onSessionUpdateFn,
  })),
}))

vi.mock('../event-adapter.js', () => ({
  mapSessionUpdateToRuntimeEvent: vi.fn().mockReturnValue(null),
}))

import type { AgentRunnerConfig } from '../agent-runner.js'
import { AgentRunner } from '../agent-runner.js'

async function collectEvents(iterable: AsyncIterable<DomainEvent>): Promise<DomainEvent[]> {
  const events: DomainEvent[] = []
  for await (const event of iterable) {
    events.push(event)
  }
  return events
}

/**
 * 创建一个已建连的 AgentRunner，内部跳过真实进程 spawn。
 */
async function createConnectedRunner(config?: Partial<AgentRunnerConfig>): Promise<AgentRunner> {
  mocks.spawnFn.mockReturnValue({ input: {}, output: {} })
  mocks.initializeFn.mockResolvedValue(undefined)
  mocks.newSessionFn.mockResolvedValue({ sessionId: 'test-session-id' })
  mocks.killFn.mockResolvedValue(undefined)
  mocks.onSessionUpdateFn.mockImplementation((handler: (update: unknown) => void) => {
    mocks.capturedSessionUpdateHandler = handler
    return () => {
      mocks.capturedSessionUpdateHandler = null
    }
  })

  const runner = new AgentRunner({ agentId: 'test-agent', ...config })
  await runner.connect()
  return runner
}

describe('AgentRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.capturedSessionUpdateHandler = null

    mocks.spawnFn.mockReturnValue({ input: {}, output: {} })
    mocks.initializeFn.mockResolvedValue(undefined)
    mocks.newSessionFn.mockResolvedValue({ sessionId: 'test-session-id' })
    mocks.killFn.mockResolvedValue(undefined)
    mocks.onSessionUpdateFn.mockImplementation((handler: (update: unknown) => void) => {
      mocks.capturedSessionUpdateHandler = handler
      return () => {
        mocks.capturedSessionUpdateHandler = null
      }
    })
  })

  it('should be constructable with config', () => {
    const config: AgentRunnerConfig = {
      agentId: 'default',
    }

    const runner = new AgentRunner(config)

    expect(runner.agentId).toBe('default')
  })

  it('should expose agentId', () => {
    const runner = new AgentRunner({
      agentId: 'claude-code',
    })

    expect(runner.agentId).toBe('claude-code')
  })

  // ---- disconnect 中止 query 循环的核心测试 ----

  it('disconnect 后 query 循环立即退出并 yield RunCancelled', async () => {
    // prompt 返回永不 resolve 的 promise，模拟 fake-slow agent
    mocks.promptFn.mockReturnValue(new Promise<never>(() => {}))

    const runner = await createConnectedRunner()
    const events: DomainEvent[] = []

    // 在后台收集事件
    const queryDone = (async () => {
      for await (const event of runner.query('hello')) {
        events.push(event)
      }
    })()

    // 稍等让循环进入 sleep 状态，再触发 disconnect
    await new Promise((resolve) => setTimeout(resolve, 30))
    await runner.disconnect()

    // 等待 query 迭代器结束
    await queryDone

    const lastEvent = events[events.length - 1]
    expect(lastEvent?.type).toBe('RunCancelled')
    if (lastEvent?.type === 'RunCancelled') {
      expect(lastEvent.reason).toBe('abort')
    }
  })

  it('disconnect 后 query 不再 yield RunCompleted（cancel 优先于 complete）', async () => {
    // prompt 返回永不 resolve 的 promise
    mocks.promptFn.mockReturnValue(new Promise<never>(() => {}))

    const runner = await createConnectedRunner()
    const events: DomainEvent[] = []

    const queryDone = (async () => {
      for await (const event of runner.query('hello')) {
        events.push(event)
      }
    })()

    await new Promise((resolve) => setTimeout(resolve, 30))
    await runner.disconnect()
    await queryDone

    const eventTypes = events.map((e) => e.type)
    expect(eventTypes).not.toContain('RunCompleted')
    expect(eventTypes).toContain('RunCancelled')
  })

  it('query 在 abort 信号触发时立即唤醒（不等待 10ms sleep 超时）', async () => {
    // prompt 永不 resolve
    mocks.promptFn.mockReturnValue(new Promise<never>(() => {}))

    const runner = await createConnectedRunner()
    const events: DomainEvent[] = []

    const start = Date.now()
    const queryDone = (async () => {
      for await (const event of runner.query('hello')) {
        events.push(event)
      }
    })()

    // 立即 disconnect，不等 10ms sleep
    await runner.disconnect()
    await queryDone
    const elapsed = Date.now() - start

    // 整个过程应在 200ms 内完成（而非多轮 10ms 轮询）
    expect(elapsed).toBeLessThan(200)
    expect(events[events.length - 1]?.type).toBe('RunCancelled')
  })

  it('正常完成时 yield RunCompleted 而非 RunCancelled', async () => {
    // prompt 正常 resolve
    mocks.promptFn.mockResolvedValue(undefined)

    const runner = await createConnectedRunner()
    const events = await collectEvents(runner.query('hello'))

    const lastEvent = events[events.length - 1]
    expect(lastEvent?.type).toBe('RunCompleted')
    expect(events.map((e) => e.type)).not.toContain('RunCancelled')
  })

  it('disconnect 后 kill 被调用', async () => {
    mocks.promptFn.mockReturnValue(new Promise<never>(() => {}))

    const runner = await createConnectedRunner()

    const queryDone = (async () => {
      for await (const _ of runner.query('hello')) {
        // drain
      }
    })()

    await new Promise((resolve) => setTimeout(resolve, 10))
    await runner.disconnect()
    await queryDone

    expect(mocks.killFn).toHaveBeenCalledTimes(1)
  })
})
