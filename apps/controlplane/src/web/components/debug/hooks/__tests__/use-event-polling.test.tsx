/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import * as api from '../../../../services/debug-api.js'
import { useDebugStore } from '../../../../stores/debug-store.js'
import { useEventPolling } from '../use-event-polling.js'

beforeEach(() => {
  useDebugStore.getState().reset()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function mockEvent(cursor: number): api.DebugEvent {
  return {
    eventId: `e-${cursor}`,
    type: 'RunStarted',
    occurredAt: new Date().toISOString(),
    correlationId: 'c',
    causationId: null,
    sequence: cursor,
    aggregateType: 'Run',
    aggregateId: 'r',
    source: { processKind: 'daemon', processId: 'p' },
    payload: {},
    cursor,
  }
}

/** 将微任务队列抽干，让 Promise.resolve() 链完成 */
async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useEventPolling', () => {
  test('挂载时 bootstrap 不带 sinceCursor', async () => {
    const spy = vi.spyOn(api, 'fetchDebugEvents').mockResolvedValue({
      events: [mockEvent(3), mockEvent(2)],
      maxCursor: 3,
      minCursor: 2,
      hasMore: false,
    })
    useDebugStore.setState({ panelOpen: true, tab: 'events', mode: 'realtime' })
    renderHook(() => useEventPolling())
    await flushMicrotasks()
    expect(spy).toHaveBeenCalled()
    expect(spy.mock.calls[0]![0]).toMatchObject({ mode: 'realtime' })
    expect(spy.mock.calls[0]![0].sinceCursor).toBeUndefined()
  })

  test('每 2 秒轮询一次并带上 sinceCursor', async () => {
    vi.spyOn(api, 'fetchDebugEvents').mockResolvedValue({
      events: [mockEvent(5)],
      maxCursor: 5,
      minCursor: 5,
      hasMore: false,
    })
    useDebugStore.setState({ panelOpen: true, tab: 'events', mode: 'realtime' })
    renderHook(() => useEventPolling())
    // flush bootstrap，让 sinceCursor 更新到 5
    await flushMicrotasks()
    expect(useDebugStore.getState().sinceCursor).toBe(5)
    // 推进 2s 触发第一次 interval tick，再 flush 让 Promise 完成
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    await flushMicrotasks()
    expect(
      (api.fetchDebugEvents as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBeGreaterThanOrEqual(2)
    const lastCall = (api.fetchDebugEvents as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
    expect(lastCall.sinceCursor).toBe(5)
  })

  test('连续 3 次失败后 store.paused 变 true', async () => {
    vi.spyOn(api, 'fetchDebugEvents').mockRejectedValue(new Error('net'))
    useDebugStore.setState({ panelOpen: true, tab: 'events', mode: 'realtime' })
    renderHook(() => useEventPolling())
    // bootstrap 失败 → consecutiveFailures = 1
    await flushMicrotasks()
    expect(useDebugStore.getState().consecutiveFailures).toBeGreaterThanOrEqual(1)
    // 第 2 次 tick → consecutiveFailures = 2
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    await flushMicrotasks()
    // 第 3 次 tick → consecutiveFailures = 3 → paused = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    await flushMicrotasks()
    expect(useDebugStore.getState().paused).toBe(true)
  })

  test('切到非 events tab 时停止轮询', async () => {
    const spy = vi.spyOn(api, 'fetchDebugEvents').mockResolvedValue({
      events: [],
      maxCursor: 0,
      minCursor: 0,
      hasMore: false,
    })
    useDebugStore.setState({ panelOpen: true, tab: 'events', mode: 'realtime' })
    renderHook(() => useEventPolling())
    // flush bootstrap，确认首次调用已发出
    await flushMicrotasks()
    expect(spy).toHaveBeenCalled()
    const baseline = spy.mock.calls.length
    // 切 tab → effect cleanup，interval 应被清除
    act(() => {
      useDebugStore.getState().setTab('nodes')
    })
    // 推进 4s 验证不再有新调用
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    await flushMicrotasks()
    expect(spy.mock.calls.length).toBe(baseline)
  })
})
