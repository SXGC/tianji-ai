import { useCallback, useRef, useState } from 'react'

export interface DraggableController {
  x: number
  y: number
  startDrag: (e: PointerEvent) => void
}

/**
 * 极简拖动 hook，只管 (x, y) 位置。不包含 resize / minimize（区别于 use-debug-window）。
 * 使用 pointer 事件以同时支持触屏和桌面。listener 在 pointerup 时自动移除。
 */
export function useDraggable(initialX: number, initialY: number): DraggableController {
  const [pos, setPos] = useState({ x: initialX, y: initialY })
  const posRef = useRef(pos)
  posRef.current = pos

  const startDrag = useCallback((e: PointerEvent) => {
    const startClientX = e.clientX
    const startClientY = e.clientY
    const startPos = posRef.current

    const onMove = (pe: PointerEvent): void => {
      setPos({
        x: startPos.x + (pe.clientX - startClientX),
        y: startPos.y + (pe.clientY - startClientY),
      })
    }

    const onEnd = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
  }, [])

  return { x: pos.x, y: pos.y, startDrag }
}
