import type { JSX } from 'react'

import type { DebugEvent } from '../../services/debug-api.js'

interface Props {
  event: DebugEvent | null
  onClose: () => void
}

/** 展示单个事件原始 envelope JSON 的侧边抽屉。 */
export function EventDetailDrawer({ event, onClose }: Props): JSX.Element | null {
  if (event === null) return null
  return (
    <div
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: '45%',
        background: '#0f0f0f',
        borderLeft: '1px solid #333',
        padding: 12,
        overflow: 'auto',
      }}
    >
      <button type="button" onClick={onClose} aria-label="关闭详情">
        ×
      </button>
      <pre data-testid="event-detail-json" style={{ margin: 0, fontSize: 12 }}>
        {JSON.stringify(event, null, 2)}
      </pre>
    </div>
  )
}
