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
