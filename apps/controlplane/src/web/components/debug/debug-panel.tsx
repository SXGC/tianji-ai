import type { JSX } from 'react'

import { useDebugStore } from '../../stores/debug-store.js'
import { useDebugWindow } from './hooks/use-debug-window.js'

const DEBUG_ENABLED = import.meta.env.VITE_ENABLE_DEBUG === 'true'

/**
 * 真正的实现。导出以便测试文件直接渲染，绕开模块级 DEBUG_ENABLED 常量在测试
 * 环境中无法运行时切换的限制。
 */
export function DebugPanelImpl(): JSX.Element | null {
  const open = useDebugStore((s) => s.panelOpen)
  const { style } = useDebugWindow({ x: 100, y: 100, width: 800, height: 500 })
  if (!open) return null
  return (
    <div
      data-testid="debug-panel-content"
      style={{
        ...style,
        background: '#1a1a1a',
        color: '#eee',
        border: '1px solid #333',
        borderRadius: 8,
      }}
    >
      {/* Toolbar 与 TabContent 由后续 Task 填入 */}
    </div>
  )
}

function EmptyComponent(): null {
  return null
}

/**
 * 浮动调试面板容器。仅当 VITE_ENABLE_DEBUG === 'true' 时导出真正实现。
 * DEBUG_ENABLED=false 时，DebugPanelImpl 未被作为 default export 引用，rollup 会连同它引入的
 * use-debug-window、后续 Task 新增的 DebugToolbar / EventListTab / NodeStatusTab / use-event-polling
 * 一起剔除。**注意：`DebugPanelImpl` 是 named export，仅用于测试直接渲染；生产代码只引用 `DebugPanel`。**
 */
export const DebugPanel = DEBUG_ENABLED ? DebugPanelImpl : EmptyComponent
