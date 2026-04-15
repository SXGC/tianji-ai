/**
 * @module bus/__tests__/pipeline
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { describe, expect, it, vi } from 'vitest'

import { CausalContext } from '../causal-context.js'
import { createAlsCausalContextProvider } from '../pipeline.js'
import { createRuntimeEventPipeline } from '../pipeline.js'
import { SequenceCounter } from '../sequence-counter.js'
import { NoopSequenceRecoverer } from '../sequence-recoverer.js'

/** 用 CausalContextRef 构造旧式 provider，方便已有测试复用。 */
function makeRefProvider(ref: { current: CausalContext }) {
  return {
    getCurrent: () => ref.current,
    update: (next: CausalContext) => {
      ref.current = next
    },
  }
}

describe('createRuntimeEventPipeline', () => {
  it('emitEvent 包 envelope 后调用 publish；同步返回', async () => {
    const publish = vi.fn()
    const contextRef = { current: CausalContext.root('c1') }
    const pipeline = createRuntimeEventPipeline({
      publish,
      counter: new SequenceCounter(),
      contextProvider: makeRefProvider(contextRef),
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
      contextProvider: makeRefProvider(contextRef),
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
    const contextRef = { current: CausalContext.root('c1') }
    const pipeline = createRuntimeEventPipeline({
      publish,
      counter: new SequenceCounter(),
      contextProvider: makeRefProvider(contextRef),
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

  it('连续两次 emitEvent 建立因果链：第二个事件的 causationId 等于第一个事件的 eventId，且两者 correlationId 相等', async () => {
    const publish = vi.fn()
    const contextRef = { current: CausalContext.root('corr-1') }
    const pipeline = createRuntimeEventPipeline({
      publish,
      counter: new SequenceCounter(),
      contextProvider: makeRefProvider(contextRef),
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
    const firstEnv = publish.mock.calls[0][0] as {
      eventId: string
      correlationId: string
      causationId: string | null
    }
    const secondEnv = publish.mock.calls[1][0] as {
      eventId: string
      correlationId: string
      causationId: string | null
    }
    // 因果链：第二个事件的 causationId 必须等于第一个事件的 eventId
    expect(secondEnv.causationId).toBe(firstEnv.eventId)
    // 同一 correlationId 贯穿整条链
    expect(firstEnv.correlationId).toBe('corr-1')
    expect(secondEnv.correlationId).toBe('corr-1')
  })
})

describe('createAlsCausalContextProvider + 并发隔离', () => {
  it('两个并发 run 各自持有独立 CausalContext，causation 链不互相污染', async () => {
    // 每个 run 使用独立的 als store，publish 收集各自事件
    const publishA: Array<{ eventId: string; correlationId: string; causationId: string | null }> =
      []
    const publishB: Array<{ eventId: string; correlationId: string; causationId: string | null }> =
      []

    const alsA = new AsyncLocalStorage<{ current: CausalContext }>()
    const alsB = new AsyncLocalStorage<{ current: CausalContext }>()

    const providerA = createAlsCausalContextProvider(alsA)
    const providerB = createAlsCausalContextProvider(alsB)

    const pipelineA = createRuntimeEventPipeline({
      publish: (env) =>
        publishA.push({
          eventId: env.eventId,
          correlationId: env.correlationId,
          causationId: env.causationId,
        }),
      counter: new SequenceCounter(),
      contextProvider: providerA,
      source: { processKind: 'daemon', processId: 'p-A' },
      recoverer: NoopSequenceRecoverer,
    })

    const pipelineB = createRuntimeEventPipeline({
      publish: (env) =>
        publishB.push({
          eventId: env.eventId,
          correlationId: env.correlationId,
          causationId: env.causationId,
        }),
      counter: new SequenceCounter(),
      contextProvider: providerB,
      source: { processKind: 'daemon', processId: 'p-B' },
      recoverer: NoopSequenceRecoverer,
    })

    // 模拟两个并发 run：runA 与 runB 交叉执行
    // 每个 run 用 als.run() 建立独立上下文，Promise.all 制造并发
    const runEvent = {
      type: 'RunStarted' as const,
      runId: 'r1' as never,
      sessionId: 's1' as never,
      triggerType: 'fresh' as never,
      timestamp: 0,
    }
    const completeEvent = {
      type: 'RunCompleted' as const,
      runId: 'r1' as never,
      sessionId: 's1' as never,
      timestamp: 0,
    }

    // runA 在 als.run 内 emit 第一个事件后，让 runB 有机会插入（用 Promise 交叉）
    let resolveYield!: () => void
    const yieldPoint = new Promise<void>((res) => {
      resolveYield = res
    })

    const runA = alsA.run({ current: CausalContext.root('corr-A') }, async () => {
      await pipelineA.emitEvent(runEvent)
      // 让出控制权，给 runB 机会在 A 的两次 emit 之间插入
      await yieldPoint
      await pipelineA.emitEvent(completeEvent)
    })

    const runB = alsB.run({ current: CausalContext.root('corr-B') }, async () => {
      // runB 在 runA 第一次 emit 后插入
      resolveYield()
      await pipelineB.emitEvent(runEvent)
      await pipelineB.emitEvent(completeEvent)
    })

    await Promise.all([runA, runB])

    // 断言 corr-A 的事件全部属于 corr-A
    expect(publishA).toHaveLength(2)
    expect(publishA[0].correlationId).toBe('corr-A')
    expect(publishA[1].correlationId).toBe('corr-A')

    // 断言 corr-B 的事件全部属于 corr-B
    expect(publishB).toHaveLength(2)
    expect(publishB[0].correlationId).toBe('corr-B')
    expect(publishB[1].correlationId).toBe('corr-B')

    // 断言 corr-A 的因果链正确：第二个事件的 causationId 指向第一个事件
    expect(publishA[1].causationId).toBe(publishA[0].eventId)

    // 断言 corr-B 的因果链正确：第二个事件的 causationId 指向第一个事件
    expect(publishB[1].causationId).toBe(publishB[0].eventId)

    // 关键断言：corr-A 的因果链不指向 corr-B 的任何事件
    const bEventIds = new Set(publishB.map((e) => e.eventId))
    expect(bEventIds.has(publishA[1].causationId as string)).toBe(false)
  })
})
