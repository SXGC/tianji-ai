import { useCallback } from 'react'

import { fetchDebugEvents } from '../../../services/debug-api.js'
import { useDebugStore } from '../../../stores/debug-store.js'

/**
 * 历史模式的分页加载器。
 * 激活条件：`mode === 'history'` 且尚未到底。
 *
 * 关键守卫：`historyMinCursor === null` 时直接返回（表示尚未加载第一页），
 * 避免没有 before_cursor 就去请求后端导致返回"全库最近 N 条"，语义错乱。
 * 第一页由 Toolbar 的"查询"按钮显式触发（走 appendEvents 写入 historyMinCursor）。
 */
export function useHistoryPagination(): () => Promise<void> {
  const appendEvents = useDebugStore((s) => s.appendEvents)
  const mode = useDebugStore((s) => s.mode)
  const reachedEnd = useDebugStore((s) => s.historyReachedEnd)
  const minCursor = useDebugStore((s) => s.historyMinCursor)
  const aggregateType = useDebugStore((s) => s.aggregateType)
  const aggregateId = useDebugStore((s) => s.aggregateId)
  const startTime = useDebugStore((s) => s.startTime)
  const endTime = useDebugStore((s) => s.endTime)

  return useCallback(async () => {
    if (mode !== 'history' || reachedEnd) return
    if (minCursor === null) return
    const res = await fetchDebugEvents({
      mode: 'history',
      beforeCursor: minCursor,
      startTime: startTime === '' ? undefined : startTime,
      endTime: endTime === '' ? undefined : endTime,
      aggregateType: aggregateType ?? undefined,
      aggregateId: aggregateId === '' ? undefined : aggregateId,
      limit: 200,
    })
    appendEvents(res.events, res.minCursor, res.hasMore)
  }, [mode, reachedEnd, minCursor, aggregateType, aggregateId, startTime, endTime, appendEvents])
}
