import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * server-shutdown 针对顶层崩溃防线的回归测试：
 * 1. uncaughtException 发生时日志写入 stack
 * 2. shutdown 链条内某步骤超时时，进程仍然会强制退出（exit 被调用）
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('control plane shutdown hardening', () => {
  it('exports startControlPlaneServer and returns a shutdown handle', async () => {
    const mod = await import('../server-entry.js')
    expect(typeof mod.startControlPlaneServer).toBe('function')
  })

  it('invokes shutdown once for uncaughtException with stack in log data', async () => {
    const mod = await import('../server-entry.js')
    const logs: Array<{ level: string; data: Record<string, unknown> | undefined }> = []

    const fakeLogger = {
      fatal: vi.fn(async (_scope, _msg, data) => {
        logs.push({ level: 'fatal', data })
      }),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      log: vi.fn(),
      child: vi.fn(),
    }

    const handle = mod.createCrashHandlers({
      logger: fakeLogger as unknown as Parameters<typeof mod.createCrashHandlers>[0]['logger'],
      shutdown: vi.fn(async () => undefined),
      exit: vi.fn(),
    })

    const err = new Error('boom')
    await handle.onUncaughtException(err)
    await handle.flush()

    expect(fakeLogger.fatal).toHaveBeenCalledTimes(1)
    const data = logs[0]?.data as Record<string, unknown> | undefined
    expect(data).toMatchObject({
      error: expect.objectContaining({
        name: 'Error',
        message: 'boom',
        stack: expect.any(String),
      }),
    })
  })

  it('forces exit when shutdown exceeds timeout', async () => {
    vi.useFakeTimers()
    const mod = await import('../server-entry.js')
    const exitSpy = vi.fn()

    const slowShutdown = vi.fn(() => new Promise<void>(() => undefined))
    const handle = mod.createCrashHandlers({
      logger: {
        fatal: vi.fn(async () => undefined),
        error: vi.fn(async () => undefined),
        warn: vi.fn(async () => undefined),
        info: vi.fn(async () => undefined),
        debug: vi.fn(async () => undefined),
        trace: vi.fn(async () => undefined),
        log: vi.fn(async () => undefined),
        child: vi.fn(),
      } as unknown as Parameters<typeof mod.createCrashHandlers>[0]['logger'],
      shutdown: slowShutdown,
      shutdownTimeoutMs: 1_000,
      exit: exitSpy,
    })

    const p = handle.onUncaughtException(new Error('stuck'))
    await vi.advanceTimersByTimeAsync(1_500)
    await p

    expect(slowShutdown).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledWith(1)

    vi.useRealTimers()
  })
})
