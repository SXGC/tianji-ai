import type { JSX } from 'react'

import { useDebugStore } from '../../stores/debug-store.js'
import { DebugToolbar } from './debug-toolbar.js'
import { EventListTab } from './event-list-tab.js'
import { useDebugWindow } from './hooks/use-debug-window.js'
import { useEventPolling } from './hooks/use-event-polling.js'
import { NodeStatusTab } from './node-status-tab.js'

const DEBUG_ENABLED = import.meta.env.VITE_ENABLE_DEBUG === 'true'

const HEADER_HEIGHT = 32

/**
 * 真正的实现。导出以便测试文件直接渲染，绕开模块级 DEBUG_ENABLED 常量在测试
 * 环境中无法运行时切换的限制。
 */
export function DebugPanelImpl(): JSX.Element | null {
  const open = useDebugStore((s) => s.panelOpen)
  const tab = useDebugStore((s) => s.tab)
  const { style, minimized, startDrag, startResize, toggleMinimize } = useDebugWindow({
    x: 100,
    y: 100,
    width: 800,
    height: 500,
  })
  useEventPolling()
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
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 拖拽手柄：整个 header 区域均可拖动 */}
      <div
        data-testid="debug-panel-header"
        onPointerDown={(e) => startDrag(e.nativeEvent)}
        style={{
          height: HEADER_HEIGHT,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px',
          background: '#222',
          borderRadius: '8px 8px 0 0',
          cursor: 'move',
          userSelect: 'none',
        }}
      >
        <span>Debug</span>
        <button
          type="button"
          aria-label="Minimize"
          onClick={toggleMinimize}
          style={{
            background: 'none',
            border: 'none',
            color: '#eee',
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 4px',
          }}
        >
          {minimized ? '▢' : '—'}
        </button>
      </div>
      {minimized ? null : (
        <>
          <DebugToolbar />
          <div style={{ flex: 1, minHeight: 0 }}>
            {tab === 'events' ? <EventListTab /> : <NodeStatusTab />}
          </div>
          {/* resize handle：绝对定位贴右下角 */}
          <div
            data-testid="debug-panel-resize-handle"
            onPointerDown={(e) => startResize(e.nativeEvent)}
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              width: 12,
              height: 12,
              cursor: 'nwse-resize',
            }}
          />
        </>
      )}
    </div>
  )
}

function EmptyComponent(): null {
  return null
}

/**
 * 浮动调试面板容器。仅当 VITE_ENABLE_DEBUG === 'true' 时导出真正实现。
 * DEBUG_ENABLED=false 时，DebugPanelImpl 未被作为 default export 引用，rollup 会连同它引入的
 * use-debug-window、DebugToolbar / EventListTab / NodeStatusTab / use-event-polling
 * 一起剔除。**注意：`DebugPanelImpl` 是 named export，仅用于测试直接渲染；生产代码只引用 `DebugPanel`。**
 */
export const DebugPanel = DEBUG_ENABLED ? DebugPanelImpl : EmptyComponent
