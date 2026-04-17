/** @vitest-environment jsdom */
import { render } from '@testing-library/react'
import type { JSX } from 'react'
import { describe, expect, test, vi } from 'vitest'

// Outlet 依赖 RouterProvider 上下文；在单元测试中 mock 掉避免 router 报错
// 禁止使用 importOriginal<typeof import(...)> 的类型级动态导入，改为显式列举 mock 符号
vi.mock('@tanstack/react-router', () => ({
  Outlet: () => null,
  createRootRoute: (options: { component: () => JSX.Element }) => ({
    component: options.component,
  }),
}))

import { RootRouteComponent } from '../__root.js'

/**
 * 默认测试环境 VITE_ENABLE_DEBUG 未设置 → DEBUG_ENABLED=false →
 * DebugToggleButton / DebugPanel 都是 EmptyComponent，不渲染任何内容。
 * "enabled" 分支由 Task 5/7/8/9 的 Impl 直接测试覆盖；本处只验证 wrapper 接线。
 */
describe('RootRouteComponent', () => {
  test('默认环境下挂载 Outlet 但不渲染 Debug 按钮/面板', () => {
    const { container } = render(<RootRouteComponent />)
    expect(container.querySelector('button[aria-label="Debug"]')).toBeNull()
    expect(container.querySelector('[data-testid="debug-panel-content"]')).toBeNull()
  })
})
