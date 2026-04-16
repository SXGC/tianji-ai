import { EventType } from '@ag-ui/client'
import type { BaseEvent } from '@ag-ui/client'
import { createMemorySink, createObserverLogger } from '@tianji/observer'
import type { ObserverMemorySink } from '@tianji/observer'
import { describe, expect, it, vi } from 'vitest'

import { AgUiEventGate, isTerminalAgUiEvent } from '../ag-ui-event-gate.js'

function makeGate() {
  const subscriber = { next: vi.fn<(e: BaseEvent) => void>() }
  const sink: ObserverMemorySink = createMemorySink()
  const logger = createObserverLogger({ sinks: [sink] })
  const gate = new AgUiEventGate(subscriber, { runId: 'run-1', threadId: 'thread-1' }, logger)
  return { subscriber, sink, logger, gate }
}

describe('AgUiEventGate', () => {
  it('T1 正常路径：START → CONTENT → END → RUN_FINISHED，无 flush 无 error 日志', () => {
    const { subscriber, sink, gate } = makeGate()

    gate.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'M1',
      role: 'assistant',
    } as BaseEvent)
    gate.emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'M1', delta: 'hi' } as BaseEvent)
    gate.emit({ type: EventType.TEXT_MESSAGE_END, messageId: 'M1' } as BaseEvent)

    const finishEv = {
      type: EventType.RUN_FINISHED,
      threadId: 'thread-1',
      runId: 'run-1',
    } as BaseEvent
    gate.emitTerminal(finishEv)

    expect(subscriber.next).toHaveBeenCalledTimes(4)
    expect(subscriber.next).toHaveBeenLastCalledWith(finishEv)
    expect(sink.entries.some((e) => e.level === 'error')).toBe(false)
    expect(gate.alreadyTerminated()).toBe(true)
  })

  it('T2 失败路径：活跃消息在 RUN_ERROR 前被 flush，error 日志列出泄漏 id', () => {
    const { subscriber, sink, gate } = makeGate()

    gate.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'M1',
      role: 'assistant',
    } as BaseEvent)
    gate.emitTerminal({ type: EventType.RUN_ERROR, message: 'boom' } as BaseEvent)

    const types = subscriber.next.mock.calls.map((c) => (c[0] as BaseEvent).type)
    expect(types).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_END', 'RUN_ERROR'])

    const errorEntries = sink.entries.filter((e) => e.level === 'error')
    expect(errorEntries).toHaveLength(1)
    expect(errorEntries[0].scope).toEqual(['controlplane', 'agents', 'ag-ui-gate'])
    expect(errorEntries[0].data).toMatchObject({
      runId: 'run-1',
      threadId: 'thread-1',
      messageIds: ['M1'],
    })
  })

  it('T4 多活跃消息按 Map 插入顺序 flush', () => {
    const { subscriber, sink, gate } = makeGate()

    gate.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'M1',
      role: 'assistant',
    } as BaseEvent)
    gate.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'M2',
      role: 'assistant',
    } as BaseEvent)

    gate.emitTerminal({
      type: EventType.RUN_FINISHED,
      threadId: 'thread-1',
      runId: 'run-1',
    } as BaseEvent)

    const endMessageIds = subscriber.next.mock.calls
      .filter((c) => (c[0] as BaseEvent).type === 'TEXT_MESSAGE_END')
      .map((c) => (c[0] as BaseEvent & { messageId: string }).messageId)
    expect(endMessageIds).toEqual(['M1', 'M2'])

    const errorEntries = sink.entries.filter((e) => e.level === 'error')
    expect(errorEntries[0].data).toMatchObject({ messageIds: ['M1', 'M2'] })
  })

  it('新建时 alreadyTerminated 为 false，未向下游发任何事件', () => {
    const { subscriber, gate } = makeGate()

    expect(gate.alreadyTerminated()).toBe(false)
    expect(subscriber.next).not.toHaveBeenCalled()
  })

  it('TEXT_MESSAGE_START 进入 active，TEXT_MESSAGE_END 移出 active', () => {
    const { subscriber, gate } = makeGate()

    const startEv = {
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'M1',
      role: 'assistant',
    } as BaseEvent
    const contentEv = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'M1',
      delta: 'hi',
    } as BaseEvent
    const endEv = { type: EventType.TEXT_MESSAGE_END, messageId: 'M1' } as BaseEvent

    gate.emit(startEv)
    gate.emit(contentEv)
    gate.emit(endEv)

    expect(subscriber.next).toHaveBeenCalledTimes(3)
    expect(subscriber.next).toHaveBeenNthCalledWith(1, startEv)
    expect(subscriber.next).toHaveBeenNthCalledWith(2, contentEv)
    expect(subscriber.next).toHaveBeenNthCalledWith(3, endEv)
  })

  it('非 TEXT / REASONING 事件原样透传', () => {
    const { subscriber, gate } = makeGate()

    const stateDelta = { type: EventType.STATE_DELTA, delta: [] } as BaseEvent
    gate.emit(stateDelta)

    expect(subscriber.next).toHaveBeenCalledWith(stateDelta)
  })

  it('T3 取消路径含 thinking：flush 发 REASONING_MESSAGE_END → REASONING_END → TEXT_MESSAGE_END', () => {
    const { subscriber, sink, gate } = makeGate()

    gate.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'M1',
      role: 'assistant',
    } as BaseEvent)
    gate.emit({ type: EventType.REASONING_START, messageId: 'M1' } as BaseEvent)
    gate.emit({ type: EventType.REASONING_MESSAGE_START, messageId: 'M1' } as BaseEvent)
    gate.emit({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: 'M1',
      delta: '...',
    } as BaseEvent)

    gate.emitTerminal({
      type: EventType.RUN_FINISHED,
      threadId: 'thread-1',
      runId: 'run-1',
      reason: 'cancelled',
    } as BaseEvent)

    const types = subscriber.next.mock.calls.map((c) => (c[0] as BaseEvent).type)
    expect(types).toEqual([
      'TEXT_MESSAGE_START',
      'REASONING_START',
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END',
      'REASONING_END',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ])
    expect(sink.entries.some((e) => e.level === 'error')).toBe(true)
  })

  it('REASONING_END 先到则清除 inThinking，后续 TEXT_MESSAGE_END 从 active 删除，无 flush', () => {
    const { subscriber, sink, gate } = makeGate()

    gate.emit({
      type: EventType.TEXT_MESSAGE_START,
      messageId: 'M1',
      role: 'assistant',
    } as BaseEvent)
    gate.emit({ type: EventType.REASONING_START, messageId: 'M1' } as BaseEvent)
    gate.emit({ type: EventType.REASONING_END, messageId: 'M1' } as BaseEvent)
    gate.emit({ type: EventType.TEXT_MESSAGE_END, messageId: 'M1' } as BaseEvent)

    gate.emitTerminal({
      type: EventType.RUN_FINISHED,
      threadId: 'thread-1',
      runId: 'run-1',
    } as BaseEvent)

    expect(sink.entries.some((e) => e.level === 'error')).toBe(false)
    const types = subscriber.next.mock.calls.map((c) => (c[0] as BaseEvent).type)
    expect(types).toEqual([
      'TEXT_MESSAGE_START',
      'REASONING_START',
      'REASONING_END',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ])
  })

  it('T8 REASONING_START 先到、TEXT_MESSAGE_START 从未到：flush 只发 REASONING 序列，不补 TEXT_MESSAGE_END', () => {
    const { subscriber, sink, gate } = makeGate()

    gate.emit({ type: EventType.REASONING_START, messageId: 'M1' } as BaseEvent)
    gate.emitTerminal({
      type: EventType.RUN_FINISHED,
      threadId: 'thread-1',
      runId: 'run-1',
    } as BaseEvent)

    const types = subscriber.next.mock.calls.map((c) => (c[0] as BaseEvent).type)
    expect(types).toEqual([
      'REASONING_START',
      'REASONING_MESSAGE_END',
      'REASONING_END',
      'RUN_FINISHED',
    ])
    expect(sink.entries.some((e) => e.level === 'error')).toBe(true)
  })
})

describe('isTerminalAgUiEvent', () => {
  it('RUN_FINISHED 是终态事件', () => {
    const event = { type: EventType.RUN_FINISHED } as BaseEvent
    expect(isTerminalAgUiEvent(event)).toBe(true)
  })

  it('RUN_ERROR 是终态事件', () => {
    const event = { type: EventType.RUN_ERROR } as BaseEvent
    expect(isTerminalAgUiEvent(event)).toBe(true)
  })

  it('TEXT_MESSAGE_START 不是终态事件', () => {
    const event = { type: EventType.TEXT_MESSAGE_START } as BaseEvent
    expect(isTerminalAgUiEvent(event)).toBe(false)
  })
})
