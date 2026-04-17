/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react'
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
    await waitFor(() => expect(spy).toHaveBeenCalled())
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
    await waitFor(() => expect(useDebugStore.getState().sinceCursor).toBe(5))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
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
    // bootstrap 失败 → failure 1
    await waitFor(() =>
      expect(useDebugStore.getState().consecutiveFailures).toBeGreaterThanOrEqual(1)
    )
    // 2s tick → failure 2；2s tick → failure 3（paused=true，effect cleanup）；
    // 第 3 次推进用于确保即使 cleanup 有延迟，也不会继续累加失败。
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000)
      })
    }
    await waitFor(() => expect(useDebugStore.getState().paused).toBe(true))
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
    await waitFor(() => expect(spy).toHaveBeenCalled())
    const baseline = spy.mock.calls.length
    useDebugStore.getState().setTab('nodes')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(spy.mock.calls.length).toBe(baseline)
  })
})
