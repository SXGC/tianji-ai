import { useEffect, useRef } from 'react'

import { fetchDebugEvents } from '../../../services/debug-api.js'
import { useDebugStore } from '../../../stores/debug-store.js'

const POLL_INTERVAL_MS = 2000

/**
 * 实时模式的轮询驱动。
 * - 激活条件：panelOpen && tab === 'events' && mode === 'realtime' && !paused
 * - 挂载 / 激活条件变化时：不带 sinceCursor 触发 bootstrap
 * - 之后每 2 秒一次增量请求
 * - 失败累计 FAILURE_THRESHOLD 次后由 store 自动切 paused
 */
export function useEventPolling(): void {
  const active = useDebugStore(
    (s) => s.panelOpen && s.tab === 'events' && s.mode === 'realtime' && !s.paused
  )
  const sinceCursor = useDebugStore((s) => s.sinceCursor)
  const aggregateType = useDebugStore((s) => s.aggregateType)
  const aggregateId = useDebugStore((s) => s.aggregateId)
  const prependEvents = useDebugStore((s) => s.prependEvents)
  const reportFailure = useDebugStore((s) => s.reportFailure)
  const reportSuccess = useDebugStore((s) => s.reportSuccess)

  const cursorRef = useRef<number | null>(null)
  cursorRef.current = sinceCursor

  useEffect(() => {
    if (!active) return
    let cancelled = false

    async function tick(isBootstrap: boolean): Promise<void> {
      try {
        const res = await fetchDebugEvents({
          mode: 'realtime',
          sinceCursor: isBootstrap ? undefined : (cursorRef.current ?? undefined),
          aggregateType: aggregateType ?? undefined,
          aggregateId: aggregateId === '' ? undefined : aggregateId,
          limit: isBootstrap ? 100 : 500,
        })
        if (cancelled) return
        if (res.events.length > 0 || isBootstrap) {
          prependEvents(res.events, res.maxCursor || cursorRef.current || 0)
        }
        reportSuccess()
      } catch (e) {
        if (cancelled) return
        reportFailure(e instanceof Error ? e.message : 'unknown')
      }
    }

    void tick(true)
    const id = setInterval(() => {
      void tick(false)
    }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [active, aggregateType, aggregateId, prependEvents, reportFailure, reportSuccess])
}
