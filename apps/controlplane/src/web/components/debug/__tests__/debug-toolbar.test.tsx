/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import * as api from '../../../services/debug-api.js'
import type { DebugEvent } from '../../../services/debug-api.js'
import { useDebugStore } from '../../../stores/debug-store.js'
import { DebugToolbar } from '../debug-toolbar.js'

function mockEvent(cursor: number): DebugEvent {
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
    payload: { hello: 'world' },
    cursor,
  }
}

beforeEach(() => {
  useDebugStore.getState().reset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('DebugToolbar', () => {
  test('切 Tab 调用 setTab', () => {
    render(<DebugToolbar />)
    fireEvent.click(screen.getByRole('tab', { name: /节点/ }))
    expect(useDebugStore.getState().tab).toBe('nodes')
  })

  test('事件流 Tab 下切模式到历史', () => {
    useDebugStore.setState({ tab: 'events', mode: 'realtime' })
    render(<DebugToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /^历史$/ }))
    expect(useDebugStore.getState().mode).toBe('history')
  })

  test('历史模式下点击查询调用 fetchDebugEvents 加载第一页', async () => {
    const newEvent = mockEvent(99)
    const spy = vi
      .spyOn(api, 'fetchDebugEvents')
      .mockResolvedValue({ events: [newEvent], maxCursor: 99, minCursor: 99, hasMore: false })
    useDebugStore.setState({
      tab: 'events',
      mode: 'history',
      startTime: '2024-01-01',
      endTime: '2024-01-02',
      events: [mockEvent(1), mockEvent(2)],
    })
    render(<DebugToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /查询/ }))
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls.at(-1)![0]).toMatchObject({
      mode: 'history',
      startTime: '2024-01-01',
      endTime: '2024-01-02',
    })
    // 锁定"先 clearEvents 再 appendEvents"的业务契约：
    // 旧的 2 条事件必须被清空，store 只保留 fetch 返回的 1 条新事件。
    expect(useDebugStore.getState().events).toHaveLength(1)
    expect(useDebugStore.getState().events[0]!.eventId).toBe('e-99')
  })

  test('历史模式查询失败时 reportFailure 把错误写入 store.lastError', async () => {
    vi.spyOn(api, 'fetchDebugEvents').mockRejectedValue(new Error('fetch error'))
    useDebugStore.setState({
      tab: 'events',
      mode: 'history',
    })
    render(<DebugToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /查询/ }))
    await vi.waitFor(() => expect(useDebugStore.getState().lastError).toBe('fetch error'))
  })

  test('熔断后显示恢复按钮并调用 resume', () => {
    useDebugStore.setState({ tab: 'events', mode: 'realtime', paused: true, lastError: 'x' })
    render(<DebugToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /恢复/ }))
    expect(useDebugStore.getState().paused).toBe(false)
  })
})
