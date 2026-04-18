/** @vitest-environment jsdom */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'

import { useDebugStore } from '../../../stores/debug-store.js'
import { DebugPanelImpl } from '../debug-panel.js'
import { DebugToggleButtonImpl } from '../debug-toggle-button.js'

// jsdom 25 尚未实现 PointerEvent 构造函数；以 MouseEvent 作为最小 polyfill，
// 保证 clientX/clientY 可读即可。
if (typeof window.PointerEvent === 'undefined') {
  // @ts-expect-error — 测试环境 polyfill，不影响生产类型
  window.PointerEvent = class PointerEvent extends MouseEvent {}
}

beforeEach(() => {
  useDebugStore.getState().reset()
})

describe('DebugToggleButtonImpl', () => {
  // 直接测试 Impl 函数，不走 DEBUG_ENABLED wrapper。
  // wrapper 的负分支（tree-shake 掉）由 Task 10 的 grep dist/ 验证。
  test('点击按钮切换面板开关', () => {
    render(<DebugToggleButtonImpl />)
    const btn = screen.getByRole('button', { name: /debug/i })
    fireEvent.click(btn)
    expect(useDebugStore.getState().panelOpen).toBe(true)
    fireEvent.click(btn)
    expect(useDebugStore.getState().panelOpen).toBe(false)
  })

  test('在按钮上 pointerdown + 全局 pointermove 会移动按钮位置', () => {
    render(<DebugToggleButtonImpl />)
    const btn = screen.getByRole('button', { name: /debug/i })

    const initialLeft = Number.parseInt(btn.style.left, 10)
    const initialTop = Number.parseInt(btn.style.top, 10)

    // pointerdown 起始点 (50, 50)
    fireEvent.pointerDown(btn, { clientX: 50, clientY: 50 })

    // pointermove (+30, +20)
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 80, clientY: 70, bubbles: true })
      )
    })

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })

    expect(Number.parseInt(btn.style.left, 10)).toBe(initialLeft + 30)
    expect(Number.parseInt(btn.style.top, 10)).toBe(initialTop + 20)
  })
})

describe('DebugPanelImpl', () => {
  test('panelOpen 为 false 时不渲染内容容器', () => {
    render(<DebugPanelImpl />)
    expect(screen.queryByTestId('debug-panel-content')).toBeNull()
  })

  test('panelOpen 为 true 时渲染内容容器', () => {
    useDebugStore.getState().togglePanel()
    render(<DebugPanelImpl />)
    expect(screen.getByTestId('debug-panel-content')).not.toBeNull()
  })

  test('点击最小化按钮隐藏 body', () => {
    useDebugStore.getState().togglePanel()
    render(<DebugPanelImpl />)

    // 面板打开时 resize handle 应存在
    expect(screen.queryByTestId('debug-panel-resize-handle')).not.toBeNull()

    // 点击最小化
    fireEvent.click(screen.getByRole('button', { name: /minimize/i }))

    // 最小化后 resize handle 应消失
    expect(screen.queryByTestId('debug-panel-resize-handle')).toBeNull()
  })

  test('在 header 上 pointerdown + 全局 pointermove + pointerup 会移动窗口', () => {
    useDebugStore.getState().togglePanel()
    render(<DebugPanelImpl />)

    const panel = screen.getByTestId('debug-panel-content')
    const header = screen.getByTestId('debug-panel-header')

    // 读取初始位置（由 useDebugWindow 初始值 x:100, y:100 决定）
    const initialLeft = Number.parseInt(panel.style.left, 10)
    const initialTop = Number.parseInt(panel.style.top, 10)

    // 在 header 按下触发 startDrag，起始点 (100, 100)
    fireEvent.pointerDown(header, { clientX: 100, clientY: 100 })

    // 全局 pointermove：移动到 (150, 120)，预期 delta (+50, +20)
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 150, clientY: 120, bubbles: true })
      )
    })

    // 全局 pointerup：结束拖拽
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })

    // 验证窗口位置已更新
    expect(Number.parseInt(panel.style.left, 10)).toBe(initialLeft + 50)
    expect(Number.parseInt(panel.style.top, 10)).toBe(initialTop + 20)
  })

  test('在 resize handle 上 pointerdown + pointermove 会改变尺寸', () => {
    useDebugStore.getState().togglePanel()
    render(<DebugPanelImpl />)

    const panel = screen.getByTestId('debug-panel-content')
    const resizeHandle = screen.getByTestId('debug-panel-resize-handle')

    // 读取初始尺寸（由 useDebugWindow 初始值 width:800, height:500 决定）
    const initialWidth = Number.parseInt(panel.style.width, 10)
    const initialHeight = Number.parseInt(panel.style.height, 10)

    // 在 resize handle 按下，起始点 (900, 600)
    fireEvent.pointerDown(resizeHandle, { clientX: 900, clientY: 600 })

    // 全局 pointermove：移动到 (1000, 680)，预期 delta (+100, +80)
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 1000, clientY: 680, bubbles: true })
      )
    })

    // 全局 pointerup：结束 resize
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })

    const newWidth = Number.parseInt(panel.style.width, 10)
    const newHeight = Number.parseInt(panel.style.height, 10)

    // 尺寸应增大且不小于最小值
    expect(newWidth).toBe(initialWidth + 100)
    expect(newHeight).toBe(initialHeight + 80)
    expect(newWidth).toBeGreaterThanOrEqual(400)
    expect(newHeight).toBeGreaterThanOrEqual(300)
  })
})
