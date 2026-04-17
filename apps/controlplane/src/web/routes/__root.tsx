import { Outlet, createRootRoute } from '@tanstack/react-router'

import { DebugPanel } from '../components/debug/debug-panel.js'
import { DebugToggleButton } from '../components/debug/debug-toggle-button.js'

export const Route = createRootRoute({
  component: RootRouteComponent,
})

/**
 * 提供 SPA 根布局出口，同时挂载仅开发环境启用的 Debug 入口。
 * DebugToggleButton 与 DebugPanel 内部都按 VITE_ENABLE_DEBUG === 'true' 严格判断；
 * 生产构建下这两个 import 的实际代码会被 rollup tree-shake 到空 EmptyComponent。
 */
export function RootRouteComponent() {
  return (
    <>
      <Outlet />
      <DebugToggleButton />
      <DebugPanel />
    </>
  )
}
