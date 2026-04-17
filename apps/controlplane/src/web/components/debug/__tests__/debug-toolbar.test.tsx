/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import * as api from '../../../services/debug-api.js'
import { useDebugStore } from '../../../stores/debug-store.js'
import { DebugToolbar } from '../debug-toolbar.js'

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
    const spy = vi
      .spyOn(api, 'fetchDebugEvents')
      .mockResolvedValue({ events: [], maxCursor: 0, minCursor: 0, hasMore: false })
    useDebugStore.setState({
      tab: 'events',
      mode: 'history',
      startTime: '2024-01-01',
      endTime: '2024-01-02',
    })
    render(<DebugToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /查询/ }))
    await vi.waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls.at(-1)![0]).toMatchObject({
      mode: 'history',
      startTime: '2024-01-01',
      endTime: '2024-01-02',
    })
  })

  test('熔断后显示恢复按钮并调用 resume', () => {
    useDebugStore.setState({ tab: 'events', mode: 'realtime', paused: true, lastError: 'x' })
    render(<DebugToolbar />)
    fireEvent.click(screen.getByRole('button', { name: /恢复/ }))
    expect(useDebugStore.getState().paused).toBe(false)
  })
})
