/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test } from 'vitest'

import { useDebugStore } from '../../../stores/debug-store.js'
import { DebugPanelImpl } from '../debug-panel.js'
import { DebugToggleButtonImpl } from '../debug-toggle-button.js'

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
})
