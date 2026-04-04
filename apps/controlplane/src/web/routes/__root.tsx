import { Outlet, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: RootRouteComponent,
})

/**
 * 提供 SPA 根布局出口。
 */
export function RootRouteComponent() {
  return <Outlet />
}
