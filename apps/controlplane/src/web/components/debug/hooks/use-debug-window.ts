import type { CSSProperties } from 'react'
import { useCallback, useRef, useState } from 'react'

/** Debug 浮动窗口的 z-index；需要压在所有业务 UI 之上、又不和系统级浮层冲突。 */
const DEBUG_Z_INDEX = 9999

const MIN_WIDTH = 400
const MIN_HEIGHT = 300

export interface WindowGeom {
  x: number
  y: number
  width: number
  height: number
}

export interface DebugWindowController {
  geom: WindowGeom
  minimized: boolean
  style: CSSProperties
  /**
   * 绑定到 header 的 onPointerDown。调用后自动接管 pointermove / pointerup
   * 完成拖拽并移除监听器。
   */
  startDrag: (e: PointerEvent) => void
  /**
   * 绑定到右下角 resize handle 的 onPointerDown。调用后自动接管
   * pointermove / pointerup 完成 resize 并移除监听器。
   */
  startResize: (e: PointerEvent) => void
  toggleMinimize: () => void
}

/**
 * 窗口拖拽 + 大小调整 + 最小化的几何状态管理。
 *
 * 采用 pointer 事件（而非 mouse 事件）以同时支持触屏和桌面。
 * listener 通过闭包捕获起始点，无需额外 React state，清理在 pointerup 时执行。
 */
export function useDebugWindow(initial: WindowGeom): DebugWindowController {
  const [geom, setGeom] = useState<WindowGeom>(initial)
  const [minimized, setMinimized] = useState(false)

  // 用 ref 存储当前 geom 快照，避免事件闭包中读取过期 state
  const geomRef = useRef<WindowGeom>(geom)
  geomRef.current = geom

  const startDrag = useCallback((e: PointerEvent) => {
    const startX = e.clientX
    const startY = e.clientY
    const startGeom = geomRef.current

    const onMove = (pe: PointerEvent): void => {
      setGeom((g) => ({
        ...g,
        x: startGeom.x + (pe.clientX - startX),
        y: startGeom.y + (pe.clientY - startY),
      }))
    }

    const onEnd = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
  }, [])

  const startResize = useCallback((e: PointerEvent) => {
    const startX = e.clientX
    const startY = e.clientY
    const startGeom = geomRef.current

    const onMove = (pe: PointerEvent): void => {
      setGeom((g) => ({
        ...g,
        width: Math.max(MIN_WIDTH, startGeom.width + (pe.clientX - startX)),
        height: Math.max(MIN_HEIGHT, startGeom.height + (pe.clientY - startY)),
      }))
    }

    const onEnd = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
  }, [])

  const toggleMinimize = useCallback(() => setMinimized((m) => !m), [])

  const style: CSSProperties = {
    position: 'fixed',
    left: geom.x,
    top: geom.y,
    width: geom.width,
    height: minimized ? 40 : geom.height,
    zIndex: DEBUG_Z_INDEX,
  }

  return { geom, minimized, style, startDrag, startResize, toggleMinimize }
}
