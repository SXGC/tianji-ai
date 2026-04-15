/**
 * @module bus/__tests__/pipeline
 */

import { describe, expect, it, vi } from 'vitest'

import { CausalContext } from '../causal-context.js'
import { createRuntimeEventPipeline } from '../pipeline.js'
import { SequenceCounter } from '../sequence-counter.js'
import { NoopSequenceRecoverer } from '../sequence-recoverer.js'

describe('createRuntimeEventPipeline', () => {
  it('emitEvent 包 envelope 后调用 publish；同步返回', async () => {
    const publish = vi.fn()
    const pipeline = createRuntimeEventPipeline({
      publish,
      counter: new SequenceCounter(),
      contextRef: { current: CausalContext.root('c1') },
      source: { processKind: 'daemon', processId: 'p1' },
      recoverer: NoopSequenceRecoverer,
    })
    await pipeline.emitEvent({
      type: 'RunStarted',
      runId: 'r1' as never,
      sessionId: 's1' as never,
      triggerType: 'fresh' as never,
      timestamp: 0,
    })
    expect(publish).toHaveBeenCalledTimes(1)
    const env = publish.mock.calls[0][0]
    expect(env.type).toBe('RunStarted')
    expect(env.sequence).toBe(1)
  })

  it('emitEvent 后更新 contextRef.current 为本事件的 child（因果链继承）', async () => {
    const publish = vi.fn()
    const contextRef = { current: CausalContext.root('c1') }
    const pipeline = createRuntimeEventPipeline({
      publish,
      counter: new SequenceCounter(),
      contextRef,
      source: { processKind: 'daemon', processId: 'p1' },
      recoverer: NoopSequenceRecoverer,
    })
    await pipeline.emitEvent({
      type: 'RunStarted',
      runId: 'r1' as never,
      sessionId: 's1' as never,
      triggerType: 'fresh' as never,
      timestamp: 0,
    })
    const publishedId = (publish.mock.calls[0][0] as { eventId: string }).eventId
    expect(contextRef.current.causationId).toBe(publishedId)
  })

  it('连续两次 emitEvent 的 sequence 递增', async () => {
    const publish = vi.fn()
    const pipeline = createRuntimeEventPipeline({
      publish,
      counter: new SequenceCounter(),
      contextRef: { current: CausalContext.root('c1') },
      source: { processKind: 'daemon', processId: 'p1' },
      recoverer: NoopSequenceRecoverer,
    })
    await pipeline.emitEvent({
      type: 'RunStarted',
      runId: 'r1' as never,
      sessionId: 's1' as never,
      triggerType: 'fresh' as never,
      timestamp: 0,
    })
    await pipeline.emitEvent({
      type: 'RunCompleted',
      runId: 'r1' as never,
      sessionId: 's1' as never,
      timestamp: 0,
    })
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish.mock.calls[0][0].sequence).toBe(1)
    expect(publish.mock.calls[1][0].sequence).toBe(2)
  })
})
