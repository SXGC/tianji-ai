/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import * as api from '../../../services/debug-api.js'
import { MAX_EVENTS, useDebugStore } from '../../../stores/debug-store.js'
import { EventListTab } from '../event-list-tab.js'

beforeEach(() => useDebugStore.getState().reset())
afterEach(() => vi.restoreAllMocks())

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
    payload: { hello: 'world' },
    cursor,
  }
}

describe('EventListTab', () => {
  test('渲染事件行按降序（cursor 大的在最上方）', () => {
    useDebugStore.setState({
      panelOpen: true,
      tab: 'events',
      mode: 'history',
      events: [mockEvent(3), mockEvent(2), mockEvent(1)],
    })
    render(<EventListTab />)
    const rows = screen.getAllByTestId('event-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.textContent).toContain('e-3')
    expect(rows[1]!.textContent).toContain('e-2')
    expect(rows[2]!.textContent).toContain('e-1')
  })

  test('点击事件行打开 Drawer 展示原始 JSON', () => {
    useDebugStore.setState({
      panelOpen: true,
      tab: 'events',
      mode: 'history',
      events: [mockEvent(1)],
    })
    render(<EventListTab />)
    fireEvent.click(screen.getByTestId('event-row'))
    expect(screen.getByTestId('event-detail-json').textContent).toContain('"eventId": "e-1"')
  })

  test('超过 MAX_EVENTS 时显示溢出提示', () => {
    const events = Array.from({ length: MAX_EVENTS }, (_, i) => mockEvent(MAX_EVENTS - i))
    useDebugStore.setState({ panelOpen: true, tab: 'events', mode: 'history', events })
    render(<EventListTab />)
    expect(screen.getByText(/3000/).textContent).toMatch(/上限|缩小/)
  })

  test('lastError 存在时显示红色 banner', () => {
    useDebugStore.setState({
      panelOpen: true,
      tab: 'events',
      mode: 'realtime',
      lastError: 'network down',
    })
    render(<EventListTab />)
    expect(screen.getByRole('alert').textContent).toContain('network down')
  })
})

describe('use-history-pagination 业务行为', () => {
  test('滚动触底调用 fetchDebugEvents 带 beforeCursor', async () => {
    const spy = vi.spyOn(api, 'fetchDebugEvents').mockResolvedValue({
      events: [mockEvent(2), mockEvent(1)],
      maxCursor: 2,
      minCursor: 1,
      hasMore: false,
    })
    useDebugStore.setState({
      panelOpen: true,
      tab: 'events',
      mode: 'history',
      events: [mockEvent(10), mockEvent(9), mockEvent(8)],
      historyMinCursor: 8,
      historyReachedEnd: false,
    })
    render(<EventListTab />)
    const list = screen.getByTestId('event-list-scroll')
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(list, 'scrollTop', { value: 400, configurable: true, writable: true })
    fireEvent.scroll(list)
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls.at(-1)![0]).toMatchObject({ mode: 'history', beforeCursor: 8 })
  })

  test('historyMinCursor 为 null 时滚动触底不会发请求', async () => {
    const spy = vi.spyOn(api, 'fetchDebugEvents').mockResolvedValue({
      events: [],
      maxCursor: 0,
      minCursor: 0,
      hasMore: false,
    })
    useDebugStore.setState({
      panelOpen: true,
      tab: 'events',
      mode: 'history',
      events: [mockEvent(10)],
      historyMinCursor: null,
      historyReachedEnd: false,
    })
    render(<EventListTab />)
    const list = screen.getByTestId('event-list-scroll')
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(list, 'scrollTop', { value: 400, configurable: true, writable: true })
    fireEvent.scroll(list)
    await Promise.resolve()
    expect(spy).not.toHaveBeenCalled()
  })
})
