import type { JSX, UIEvent } from 'react'
import { useRef, useState } from 'react'

import type { DebugEvent } from '../../services/debug-api.js'
import { MAX_EVENTS, useDebugStore } from '../../stores/debug-store.js'
import { EventDetailDrawer } from './event-detail-drawer.js'
import { useHistoryPagination } from './hooks/use-history-pagination.js'

const SCROLL_THRESHOLD_PX = 200

/**
 * 选中 GraphRunCompleted 事件时，从 store 找同 aggregateId 的 GraphRunStarted，取其 mermaidDiagram。
 *
 * 用 typeof 守卫而非 as 断言：字段缺失（旧事件）返回 null 是正常路径；
 * 字段存在但类型异常（例如重命名或后端契约漂移）则用 error 日志暴露，避免静默失效。
 */
function findMermaidDiagram(selectedEvent: DebugEvent, events: DebugEvent[]): string | null {
  if (selectedEvent.type !== 'GraphRunCompleted') return null
  const started = events.find(
    (e) => e.type === 'GraphRunStarted' && e.aggregateId === selectedEvent.aggregateId
  )
  if (started === undefined) return null
  const raw = started.payload.mermaidDiagram
  if (raw === undefined) return null
  if (typeof raw !== 'string') {
    console.error('[debug] GraphRunStarted.payload.mermaidDiagram is not a string', typeof raw, raw)
    return null
  }
  return raw
}

/** 事件列表主体 Tab，含降序渲染、溢出提示、错误 banner 与历史分页。 */
export function EventListTab(): JSX.Element {
  const events = useDebugStore((s) => s.events)
  const lastError = useDebugStore((s) => s.lastError)
  const reachedEnd = useDebugStore((s) => s.historyReachedEnd)
  const reportFailure = useDebugStore((s) => s.reportFailure)
  const loadMore = useHistoryPagination()
  const [selected, setSelected] = useState<DebugEvent | null>(null)
  const [mermaidDiagram, setMermaidDiagram] = useState<string | null>(null)
  const loadingRef = useRef(false)

  const handleSelect = (ev: DebugEvent): void => {
    setSelected(ev)
    setMermaidDiagram(findMermaidDiagram(ev, events))
  }

  const handleClose = (): void => {
    setSelected(null)
    setMermaidDiagram(null)
  }

  const onScroll = (e: UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight > SCROLL_THRESHOLD_PX) return
    if (loadingRef.current || reachedEnd) return
    loadingRef.current = true
    loadMore()
      .catch((err: unknown) => {
        reportFailure(err instanceof Error ? err.message : 'unknown')
      })
      .finally(() => {
        loadingRef.current = false
      })
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      {lastError !== null && (
        <output
          aria-live="polite"
          style={{ display: 'block', background: '#5a1f1f', color: '#fff', padding: 6 }}
        >
          轮询失败：{lastError}
        </output>
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
            onClick={() => handleSelect(ev)}
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
            {ev.occurredAt} · {ev.type} · {ev.aggregateType} · {ev.aggregateId.slice(0, 12)} · #
            {ev.cursor} · {ev.eventId}
          </button>
        ))}
        {reachedEnd && <div style={{ padding: 8, color: '#888' }}>已到底部</div>}
      </div>
      <EventDetailDrawer event={selected} mermaidDiagram={mermaidDiagram} onClose={handleClose} />
    </div>
  )
}
