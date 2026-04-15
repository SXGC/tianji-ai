import type { MessageStartedEvent, RunStartedEvent } from '@tianji/shared'
import { describe, expect, it } from 'vitest'
import { CausalContext } from '../causal-context.js'
import { createEnvelopeWrapper } from '../envelope-wrapper.js'
import { SequenceCounter } from '../sequence-counter.js'
import { NoopSequenceRecoverer } from '../sequence-recoverer.js'

describe('createEnvelopeWrapper', () => {
  it('根事件：correlationId 注入、causationId=null、sequence=1', async () => {
    const counter = new SequenceCounter()
    const ctx = { current: CausalContext.root('corr_1') }
    const wrap = createEnvelopeWrapper({
      counter,
      context: ctx,
      source: { processKind: 'daemon', processId: 'p1' },
      recoverer: NoopSequenceRecoverer,
      now: () => '2026-04-14T00:00:00Z',
    })

    const event: RunStartedEvent = {
      type: 'RunStarted',
      runId: 'r1',
      sessionId: 's1',
      triggerType: 'fresh',
      timestamp: 1,
    }

    const env = await wrap(event)

    expect(env.type).toBe('RunStarted')
    expect(env.aggregateType).toBe('Run')
    expect(env.aggregateId).toBe('r1')
    expect(env.correlationId).toBe('corr_1')
    expect(env.causationId).toBeNull()
    expect(env.sequence).toBe(1)
    expect(env.occurredAt).toBe('2026-04-14T00:00:00Z')
    expect(env.source).toEqual({ processKind: 'daemon', processId: 'p1' })
    expect(typeof env.eventId).toBe('string')
    expect(env.eventId.length).toBeGreaterThan(10)
    expect(env.payload).toBe(event)
  })

  it('同聚合连续 wrap sequence 递增', async () => {
    const counter = new SequenceCounter()
    const ctx = { current: CausalContext.root('c1') }
    const wrap = createEnvelopeWrapper({
      counter,
      context: ctx,
      source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
      recoverer: NoopSequenceRecoverer,
      now: () => 'T',
    })

    const e1Event: RunStartedEvent = {
      type: 'RunStarted',
      runId: 'r1',
      sessionId: 's1',
      triggerType: 'fresh',
      timestamp: 0,
    }
    const e2Event: MessageStartedEvent = {
      type: 'MessageStarted',
      runId: 'r1',
      messageId: 'm1',
      message: {} as never,
      timestamp: 0,
    }

    const e1 = await wrap(e1Event)
    const e2 = await wrap(e2Event)
    expect(e1.sequence).toBe(1)
    expect(e2.sequence).toBe(2)
  })

  it('首次发射时用 recoverer.maxSequence 初始化计数器', async () => {
    const counter = new SequenceCounter()
    const ctx = { current: CausalContext.root('c1') }
    const wrap = createEnvelopeWrapper({
      counter,
      context: ctx,
      source: { processKind: 'node', processId: 'p1' },
      recoverer: {
        async maxSequence() {
          return 10
        },
      },
      now: () => 'T',
    })

    const env = await wrap({
      type: 'RunStarted',
      runId: 'r1',
      sessionId: 's1',
      triggerType: 'fresh',
      timestamp: 0,
    })
    expect(env.sequence).toBe(11)
  })

  it('不同聚合 key 的 recoverer 只调用一次', async () => {
    const counter = new SequenceCounter()
    const ctx = { current: CausalContext.root('c1') }
    let callCount = 0
    const wrap = createEnvelopeWrapper({
      counter,
      context: ctx,
      source: { processKind: 'node', processId: 'p1' },
      recoverer: {
        async maxSequence() {
          callCount++
          return null
        },
      },
      now: () => 'T',
    })

    await wrap({
      type: 'RunStarted',
      runId: 'r1',
      sessionId: 's1',
      triggerType: 'fresh',
      timestamp: 0,
    })
    await wrap({
      type: 'RunCompleted',
      runId: 'r1',
      sessionId: 's1',
      triggerType: 'fresh',
      timestamp: 0,
    })
    expect(callCount).toBe(1)
  })
})
