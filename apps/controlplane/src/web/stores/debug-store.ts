import { create } from 'zustand'

import type { DebugEvent } from '../services/debug-api.js'

export const MAX_EVENTS = 3000
export const FAILURE_THRESHOLD = 3

export type DebugTab = 'events' | 'nodes'
export type DebugMode = 'realtime' | 'history'
export type AggregateType = 'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node'

export interface DebugState {
  panelOpen: boolean
  tab: DebugTab
  mode: DebugMode

  aggregateType: AggregateType | null
  aggregateId: string
  startTime: string
  endTime: string

  events: DebugEvent[]
  sinceCursor: number | null
  historyReachedEnd: boolean
  historyMinCursor: number | null

  paused: boolean
  consecutiveFailures: number
  lastError: string | null

  togglePanel: () => void
  setTab: (tab: DebugTab) => void
  setMode: (mode: DebugMode) => void
  setAggregateType: (t: AggregateType | null) => void
  setAggregateId: (id: string) => void
  setTimeRange: (start: string, end: string) => void

  prependEvents: (newer: DebugEvent[], newMaxCursor: number) => void
  appendEvents: (older: DebugEvent[], newMinCursor: number, hasMore: boolean) => void
  clearEvents: () => void

  reportFailure: (reason: string) => void
  reportSuccess: () => void
  pause: () => void
  resume: () => void

  reset: () => void
}

const initial = {
  panelOpen: false,
  tab: 'events' as DebugTab,
  mode: 'realtime' as DebugMode,
  aggregateType: null as AggregateType | null,
  aggregateId: '',
  startTime: '',
  endTime: '',
  events: [] as DebugEvent[],
  sinceCursor: null as number | null,
  historyReachedEnd: false,
  historyMinCursor: null as number | null,
  paused: false,
  consecutiveFailures: 0,
  lastError: null as string | null,
}

/**
 * 过滤条件变更时同步清空事件列表与游标，防止残留脏数据。
 */
function resetListOnFilterChange<T extends object>(patch: T) {
  return {
    ...patch,
    events: [] as DebugEvent[],
    sinceCursor: null,
    historyReachedEnd: false,
    historyMinCursor: null,
  }
}

export const useDebugStore = create<DebugState>((set) => ({
  ...initial,

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setTab: (tab) => set({ tab }),
  setMode: (mode) => set(resetListOnFilterChange({ mode })),
  setAggregateType: (t) => set(resetListOnFilterChange({ aggregateType: t })),
  setAggregateId: (id) => set(resetListOnFilterChange({ aggregateId: id })),
  setTimeRange: (startTime, endTime) => set(resetListOnFilterChange({ startTime, endTime })),

  /**
   * 将更新的事件前插到列表头部，保持 cursor 降序排列。
   *
   * @param newer - 按 cursor 降序的新事件数组（最新在前）
   * @param newMaxCursor - 本次响应的最大 cursor，用于更新 sinceCursor
   *
   * 按 cursor 去重：若某事件的 cursor 已在当前列表中，跳过该条（处理实时增量与 bootstrap 重叠）。
   * 列表总长度上限为 MAX_EVENTS。
   */
  prependEvents: (newer, newMaxCursor) =>
    set((s) => {
      if (newer.length === 0) {
        return { sinceCursor: Math.max(s.sinceCursor ?? 0, newMaxCursor) }
      }
      const existing = new Set(s.events.map((e) => e.cursor))
      const deduped = newer.filter((e) => !existing.has(e.cursor))
      if (deduped.length === 0) {
        return { sinceCursor: Math.max(s.sinceCursor ?? 0, newMaxCursor) }
      }
      const merged = [...deduped, ...s.events].slice(0, MAX_EVENTS)
      return { events: merged, sinceCursor: Math.max(s.sinceCursor ?? 0, newMaxCursor) }
    }),

  /**
   * 将历史事件追加到列表尾部，用于历史模式向上翻页。
   *
   * @param older - 按 cursor 降序的更老事件数组（追加到列表尾部）
   * @param newMinCursor - 本次响应的最小 cursor
   * @param hasMore - 是否还有更早的数据
   */
  appendEvents: (older, newMinCursor, hasMore) =>
    set((s) => {
      const existing = new Set(s.events.map((e) => e.cursor))
      const deduped = older.filter((e) => !existing.has(e.cursor))
      const merged = [...s.events, ...deduped].slice(0, MAX_EVENTS)
      return {
        events: merged,
        historyMinCursor: newMinCursor,
        historyReachedEnd: !hasMore,
      }
    }),

  clearEvents: () =>
    set({ events: [], sinceCursor: null, historyReachedEnd: false, historyMinCursor: null }),

  /**
   * 记录一次轮询失败，连续失败达到 FAILURE_THRESHOLD 时自动切换到暂停态。
   *
   * @param reason - 失败原因描述，会写入 lastError
   */
  reportFailure: (reason) =>
    set((s) => {
      const next = s.consecutiveFailures + 1
      return {
        consecutiveFailures: next,
        lastError: reason,
        paused: next >= FAILURE_THRESHOLD ? true : s.paused,
      }
    }),

  reportSuccess: () => set({ consecutiveFailures: 0, lastError: null }),
  pause: () => set({ paused: true }),

  /** 解除暂停并清零熔断计数，允许轮询继续。 */
  resume: () => set({ paused: false, consecutiveFailures: 0, lastError: null }),

  reset: () => set(initial),
}))
