import type { CSSProperties } from 'react'
import { useCallback, useState } from 'react'

export interface WindowGeom {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 窗口拖拽 + 大小调整 + 最小化的几何状态管理。
 * 不负责具体渲染，只暴露 style 与事件 handler。
 */
export function useDebugWindow(initial: WindowGeom) {
  const [geom, setGeom] = useState<WindowGeom>(initial)
  const [minimized, setMinimized] = useState(false)

  const onDrag = useCallback((dx: number, dy: number) => {
    setGeom((g) => ({ ...g, x: g.x + dx, y: g.y + dy }))
  }, [])

  const onResize = useCallback((dw: number, dh: number) => {
    setGeom((g) => ({
      ...g,
      width: Math.max(400, g.width + dw),
      height: Math.max(300, g.height + dh),
    }))
  }, [])

  const toggleMinimize = useCallback(() => setMinimized((m) => !m), [])

  const style: CSSProperties = {
    position: 'fixed',
    left: geom.x,
    top: geom.y,
    width: geom.width,
    height: minimized ? 40 : geom.height,
    zIndex: 9999,
  }

  return { geom, minimized, style, onDrag, onResize, toggleMinimize }
}
