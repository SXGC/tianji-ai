import type { ChangeEvent, JSX } from 'react'

import { fetchDebugEvents } from '../../services/debug-api.js'
import { type AggregateType, useDebugStore } from '../../stores/debug-store.js'

const AGGREGATE_TYPES: AggregateType[] = ['Session', 'GraphRun', 'Run', 'Task', 'Node']

/**
 * Debug Panel 顶部工具栏。
 *
 * 职责：
 * - Tab 切换（事件流 / 节点状态）
 * - 模式切换（实时 / 历史），仅在事件流 Tab 下显示
 * - aggregateType / aggregateId 过滤器
 * - 时间范围（仅历史模式）
 * - 历史模式"查询"按钮：手动触发第一页加载
 * - 实时模式"暂停" / "恢复"按钮
 * - 熔断后的"恢复"按钮（paused && lastError 时）
 * - "清空"按钮
 */
export function DebugToolbar(): JSX.Element {
  const tab = useDebugStore((s) => s.tab)
  const mode = useDebugStore((s) => s.mode)
  const paused = useDebugStore((s) => s.paused)
  const aggregateType = useDebugStore((s) => s.aggregateType)
  const aggregateId = useDebugStore((s) => s.aggregateId)
  const startTime = useDebugStore((s) => s.startTime)
  const endTime = useDebugStore((s) => s.endTime)

  const setTab = useDebugStore((s) => s.setTab)
  const setMode = useDebugStore((s) => s.setMode)
  const setAggregateType = useDebugStore((s) => s.setAggregateType)
  const setAggregateId = useDebugStore((s) => s.setAggregateId)
  const setTimeRange = useDebugStore((s) => s.setTimeRange)
  const clearEvents = useDebugStore((s) => s.clearEvents)
  const pause = useDebugStore((s) => s.pause)
  const resume = useDebugStore((s) => s.resume)
  const appendEvents = useDebugStore((s) => s.appendEvents)

  /**
   * 历史模式下手动查询第一页：清空旧列表后发起请求，结果追加到 store。
   * 异常不捕获，让错误自然抛出。
   */
  async function runHistoryQuery(): Promise<void> {
    clearEvents()
    const res = await fetchDebugEvents({
      mode: 'history',
      startTime: startTime === '' ? undefined : startTime,
      endTime: endTime === '' ? undefined : endTime,
      aggregateType: aggregateType ?? undefined,
      aggregateId: aggregateId === '' ? undefined : aggregateId,
      limit: 200,
    })
    appendEvents(res.events, res.minCursor, res.hasMore)
  }

  function handleAggregateTypeChange(e: ChangeEvent<HTMLSelectElement>): void {
    setAggregateType(e.target.value === '' ? null : (e.target.value as AggregateType))
  }

  function handleAggregateIdChange(e: ChangeEvent<HTMLInputElement>): void {
    setAggregateId(e.target.value)
  }

  function handleStartTimeChange(e: ChangeEvent<HTMLInputElement>): void {
    setTimeRange(e.target.value, endTime)
  }

  function handleEndTimeChange(e: ChangeEvent<HTMLInputElement>): void {
    setTimeRange(startTime, e.target.value)
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: 6,
        borderBottom: '1px solid #333',
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      <div role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'events'}
          onClick={() => setTab('events')}
        >
          事件流
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'nodes'}
          onClick={() => setTab('nodes')}
        >
          节点状态
        </button>
      </div>

      {tab === 'events' && (
        <>
          <button
            type="button"
            onClick={() => setMode('realtime')}
            aria-pressed={mode === 'realtime'}
          >
            实时
          </button>
          <button
            type="button"
            onClick={() => setMode('history')}
            aria-pressed={mode === 'history'}
          >
            历史
          </button>

          <select value={aggregateType ?? ''} onChange={handleAggregateTypeChange}>
            <option value="">全部类型</option>
            {AGGREGATE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <input
            placeholder="aggregate_id"
            value={aggregateId}
            onChange={handleAggregateIdChange}
          />

          {mode === 'history' && (
            <>
              <input
                type="text"
                placeholder="start_time ISO"
                value={startTime}
                onChange={handleStartTimeChange}
              />
              <input
                type="text"
                placeholder="end_time ISO"
                value={endTime}
                onChange={handleEndTimeChange}
              />
              <button type="button" onClick={() => void runHistoryQuery()}>
                查询
              </button>
            </>
          )}

          {mode === 'realtime' &&
            (paused ? (
              <button type="button" onClick={resume}>
                恢复
              </button>
            ) : (
              <button type="button" onClick={pause}>
                暂停
              </button>
            ))}

          <button type="button" onClick={clearEvents}>
            清空
          </button>
        </>
      )}
    </div>
  )
}
