import { describe, expect, test } from 'vitest'

import type { DebugEvent } from '../../services/debug-api.js'
import { FAILURE_THRESHOLD, MAX_EVENTS, useDebugStore } from '../debug-store.js'

function reset() {
  useDebugStore.getState().reset()
}

function makeEvent(cursor: number): DebugEvent {
  return {
    eventId: `e-${cursor}`,
    type: 'RunStarted',
    occurredAt: new Date().toISOString(),
    correlationId: 'c',
    causationId: null,
    sequence: cursor,
    aggregateType: 'Run',
    aggregateId: 'r-1',
    source: { processKind: 'daemon', processId: 'p-1' },
    payload: {},
    cursor,
  }
}

describe('debug-store 事件列表', () => {
  test('prependEvents 保持降序且不超过 MAX_EVENTS', () => {
    reset()
    const old = Array.from({ length: MAX_EVENTS }, (_, i) => makeEvent(i + 1)).reverse()
    useDebugStore.getState().prependEvents(old, MAX_EVENTS)
    useDebugStore.getState().prependEvents([makeEvent(MAX_EVENTS + 1)], MAX_EVENTS + 1)
    const events = useDebugStore.getState().events
    expect(events).toHaveLength(MAX_EVENTS)
    expect(events[0]!.cursor).toBe(MAX_EVENTS + 1)
    expect(events.at(-1)!.cursor).toBe(2)
  })

  test('过滤条件变更会重置事件列表与游标', () => {
    reset()
    useDebugStore.getState().prependEvents([makeEvent(5), makeEvent(4)], 5)
    useDebugStore.getState().setAggregateType('Session')
    expect(useDebugStore.getState().events).toHaveLength(0)
    expect(useDebugStore.getState().sinceCursor).toBeNull()
  })

  test('prependEvents 按 cursor 去重，不会出现重复行', () => {
    reset()
    useDebugStore.getState().prependEvents([makeEvent(3), makeEvent(2), makeEvent(1)], 3)
    useDebugStore.getState().prependEvents([makeEvent(4), makeEvent(3)], 4)
    const cursors = useDebugStore.getState().events.map((e) => e.cursor)
    expect(cursors).toEqual([4, 3, 2, 1])
  })
})

describe('debug-store 熔断', () => {
  test('连续 FAILURE_THRESHOLD 次失败后切换到暂停态', () => {
    reset()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      useDebugStore.getState().reportFailure('net')
    }
    expect(useDebugStore.getState().paused).toBe(true)
    expect(useDebugStore.getState().lastError).toContain('net')
  })

  test('resume 会清零失败计数并解除暂停', () => {
    reset()
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      useDebugStore.getState().reportFailure('net')
    }
    useDebugStore.getState().resume()
    expect(useDebugStore.getState().paused).toBe(false)
    expect(useDebugStore.getState().consecutiveFailures).toBe(0)
  })
})
