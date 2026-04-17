import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CrashHandlerOptions } from '../server-entry.js'

/**
 * server-shutdown 针对顶层崩溃防线的回归测试：
 * 1. uncaughtException 发生时日志写入 stack
 * 2. shutdown 链条内某步骤超时时，进程仍然会强制退出（exit 被调用）
 * 3. shutdown 在超时前完成时，timer 被清除（事件循环不泄漏）
 * 4. 并发信号只触发一次 shutdown 和 exit
 */

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

/** 创建满足 CrashHandlerOptions['logger'] 形状的假 logger，避免重复类型转换。 */
function createFakeLogger() {
  return {
    fatal: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
    warn: vi.fn(async () => undefined),
    info: vi.fn(async () => undefined),
    debug: vi.fn(async () => undefined),
    trace: vi.fn(async () => undefined),
    log: vi.fn(async () => undefined),
    child: vi.fn(),
  } as unknown as CrashHandlerOptions['logger']
}

describe('control plane shutdown hardening', () => {
  it('exports startControlPlaneServer as a function', async () => {
    const mod = await import('../server-entry.js')
    expect(typeof mod.startControlPlaneServer).toBe('function')
  })

  it('loads .env.local after .env from repo root', async () => {
    vi.resetModules()
    const mod = await import('../server-entry.js')

    const loader = {
      existsSync: (filePath: string) => {
        const path = String(filePath)
        return path.endsWith('/.env') || path.endsWith('/.env.local')
      },
      readFileSync: (filePath: string) => {
        const path = String(filePath)
        if (path.endsWith('/.env')) {
          return 'TIANJI_DEBUG=false\nVITE_ENABLE_DEBUG=false\n'
        }
        if (path.endsWith('/.env.local')) {
          return 'TIANJI_DEBUG=true\nVITE_ENABLE_DEBUG=true\n'
        }
        throw new Error(`unexpected env file: ${path}`)
      },
    }

    mod.loadControlPlaneRootEnv(loader)

    expect(process.env.TIANJI_DEBUG).toBe('true')
    expect(process.env.VITE_ENABLE_DEBUG).toBe('true')
  })

  it('invokes shutdown once for uncaughtException with stack in log data', async () => {
    const mod = await import('../server-entry.js')
    const logs: Array<{ level: string; data: Record<string, unknown> | undefined }> = []

    const fakeLogger = {
      fatal: vi.fn(async (_scope: unknown, _msg: unknown, data: Record<string, unknown>) => {
        logs.push({ level: 'fatal', data })
      }),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      log: vi.fn(),
      child: vi.fn(),
    } as unknown as CrashHandlerOptions['logger']

    const handle = mod.createCrashHandlers({
      logger: fakeLogger,
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
      logger: createFakeLogger(),
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

  it('clears the race timer when shutdown wins before timeout', async () => {
    vi.useFakeTimers()
    const mod = await import('../server-entry.js')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    const fastShutdown = vi.fn(async () => {
      // 快速完成，远早于超时
    })
    const handle = mod.createCrashHandlers({
      logger: createFakeLogger(),
      shutdown: fastShutdown,
      shutdownTimeoutMs: 10_000,
      exit: vi.fn(),
    })

    const p = handle.onUncaughtException(new Error('fast'))
    // 推进少量时间，让 fastShutdown 解析但不触发超时
    await vi.advanceTimersByTimeAsync(0)
    await p

    // shutdown 赢了，计时器必须被清除，不能让事件循环挂住
    expect(clearTimeoutSpy).toHaveBeenCalled()

    vi.useRealTimers()
  })

  it('multiple rapid signals only invoke shutdown and exit once', async () => {
    vi.useFakeTimers()
    const mod = await import('../server-entry.js')
    const exitSpy = vi.fn()
    const shutdownSpy = vi.fn(async () => undefined)

    const handle = mod.createCrashHandlers({
      logger: createFakeLogger(),
      shutdown: shutdownSpy,
      shutdownTimeoutMs: 1_000,
      exit: exitSpy,
    })

    // 并发触发两次信号
    const p1 = handle.onSignal('SIGTERM')
    const p2 = handle.onSignal('SIGINT')

    await vi.advanceTimersByTimeAsync(1_500)
    await Promise.all([p1, p2])

    expect(shutdownSpy).toHaveBeenCalledTimes(1)
    expect(exitSpy).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })
})
