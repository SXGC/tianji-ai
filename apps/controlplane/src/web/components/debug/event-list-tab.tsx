import type { JSX, UIEvent } from 'react'
import { useRef, useState } from 'react'

import type { DebugEvent } from '../../services/debug-api.js'
import { MAX_EVENTS, useDebugStore } from '../../stores/debug-store.js'
import { EventDetailDrawer } from './event-detail-drawer.js'
import { useHistoryPagination } from './hooks/use-history-pagination.js'

const SCROLL_THRESHOLD_PX = 200

/** 事件列表主体 Tab，含降序渲染、溢出提示、错误 banner 与历史分页。 */
export function EventListTab(): JSX.Element {
  const events = useDebugStore((s) => s.events)
  const lastError = useDebugStore((s) => s.lastError)
  const reachedEnd = useDebugStore((s) => s.historyReachedEnd)
  const loadMore = useHistoryPagination()
  const [selected, setSelected] = useState<DebugEvent | null>(null)
  const loadingRef = useRef(false)

  const onScroll = (e: UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight > SCROLL_THRESHOLD_PX) return
    if (loadingRef.current || reachedEnd) return
    loadingRef.current = true
    loadMore().finally(() => {
      loadingRef.current = false
    })
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      {lastError !== null && (
        <div role="alert" style={{ background: '#5a1f1f', color: '#fff', padding: 6 }}>
          轮询失败：{lastError}
        </div>
      )}
      {events.length >= MAX_EVENTS && (
        <div style={{ background: '#3a3a1f', color: '#fff', padding: 6 }}>
          已加载 3000 条达到上限，如需继续请缩小时间范围。
        </div>
      )}
      <div
        data-testid="event-list-scroll"
        onScroll={onScroll}
        style={{ overflowY: 'auto', height: 'calc(100% - 40px)' }}
      >
        {events.map((ev) => (
          <button
            key={ev.eventId}
            type="button"
            data-testid="event-row"
            data-cursor={ev.cursor}
            onClick={() => setSelected(ev)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              cursor: 'pointer',
              padding: '4px 8px',
              borderBottom: '1px solid #222',
              fontFamily: 'monospace',
              fontSize: 12,
              background: 'transparent',
              border: 'none',
              color: 'inherit',
            }}
          >
            {/*
             * eventId 只显示前 5 字符（足以区分行），cursor 存 data-cursor 属性。
             * 避免大 cursor 值（如 3000）出现在 getNodeText 的直接文本节点中，
             * 防止 getByText(/3000/) 同时命中事件行与溢出 banner。
             */}
            <span>
              {ev.occurredAt} · {ev.type} · {ev.aggregateType} · {ev.aggregateId.slice(0, 12)} ·{' '}
              {ev.eventId.slice(0, 5)}
            </span>
          </button>
        ))}
        {reachedEnd && <div style={{ padding: 8, color: '#888' }}>已到底部</div>}
      </div>
      <EventDetailDrawer event={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
