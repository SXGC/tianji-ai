import type { JSX } from 'react'

import { useDebugStore } from '../../stores/debug-store.js'
import { useDraggable } from './hooks/use-draggable.js'

/**
 * 判断在模块顶层完成，值在 build 时被 Vite 内联为常量 false 或 true。
 * 这样 `DEBUG_ENABLED ? DebugToggleButtonImpl : EmptyComponent` 在 DEBUG_ENABLED=false 时
 * 让 DebugToggleButtonImpl 变成未被引用的 binding，rollup DCE 可以连同它的内部依赖一起剔除。
 */
const DEBUG_ENABLED = import.meta.env.VITE_ENABLE_DEBUG === 'true'

/**
 * 真正的实现。导出以便测试文件直接验证其渲染/点击行为，绕开模块级 DEBUG_ENABLED 常量
 * 在 test 环境无法运行时切换的限制（vi.stubEnv 无法重置已经计算好的 const）。
 */
export function DebugToggleButtonImpl(): JSX.Element {
  const togglePanel = useDebugStore((s) => s.togglePanel)
  const { x, y, startDrag } = useDraggable(window.innerWidth - 80, window.innerHeight - 52)
  return (
    <button
      type="button"
      onClick={togglePanel}
      onPointerDown={(e) => startDrag(e.nativeEvent)}
      aria-label="Debug"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 9999,
        padding: '8px 12px',
        borderRadius: 8,
        border: '1px solid #333',
        background: '#111',
        color: '#fff',
        cursor: 'grab',
        userSelect: 'none',
      }}
    >
      Debug
    </button>
  )
}

function EmptyComponent(): null {
  return null
}

/**
 * 右下角的 Debug 开关。仅当 VITE_ENABLE_DEBUG === 'true' 时才导出真正的实现，
 * 否则导出一个静态返回 null 的空组件；实现函数与其依赖被 Vite tree-shake。
 */
export const DebugToggleButton = DEBUG_ENABLED ? DebugToggleButtonImpl : EmptyComponent
