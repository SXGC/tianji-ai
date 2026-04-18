/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { useDraggable } from '../use-draggable.js'

if (typeof window.PointerEvent === 'undefined') {
  // @ts-expect-error — 测试环境 polyfill
  window.PointerEvent = class PointerEvent extends MouseEvent {}
}

afterEach(() => {
  // pointermove/pointerup 监听器在 pointerup 触发后自动移除，无需手动清理
})

describe('useDraggable', () => {
  test('初始位置由参数决定', () => {
    const { result } = renderHook(() => useDraggable(100, 200))
    expect(result.current.x).toBe(100)
    expect(result.current.y).toBe(200)
  })

  test('pointerdown + pointermove 更新位置', () => {
    const { result } = renderHook(() => useDraggable(100, 200))

    // pointerdown 起始点 (110, 220)，与初始位置的偏移 = (10, 20)
    act(() => {
      result.current.startDrag(new PointerEvent('pointerdown', { clientX: 110, clientY: 220 }))
    })

    // pointermove 到 (160, 260)，delta = (+50, +40)，新位置 = (150, 240)
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 160, clientY: 260, bubbles: true })
      )
    })

    expect(result.current.x).toBe(150)
    expect(result.current.y).toBe(240)
  })

  test('pointerup 后 pointermove 不再更新位置', () => {
    const { result } = renderHook(() => useDraggable(100, 200))

    act(() => {
      result.current.startDrag(new PointerEvent('pointerdown', { clientX: 100, clientY: 200 }))
    })

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })

    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 999, clientY: 999, bubbles: true })
      )
    })

    expect(result.current.x).toBe(100)
    expect(result.current.y).toBe(200)
  })
})
