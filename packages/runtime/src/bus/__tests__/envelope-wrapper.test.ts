import type { MessageStartedEvent, RunStartedEvent, TaskStartedEvent } from '@tianji/shared'
import { describe, expect, it } from 'vitest'
import { CausalContext } from '../causal-context.js'
import { createEnvelopeWrapper } from '../envelope-wrapper.js'
import type { CausalContextProvider } from '../pipeline.js'
import { SequenceCounter } from '../sequence-counter.js'
import { NoopSequenceRecoverer } from '../sequence-recoverer.js'

/** 把可变 ref 包装成 CausalContextProvider，便于测试。 */
function makeRefProvider(ref: { current: CausalContext }): CausalContextProvider {
  return {
    getCurrent: () => ref.current,
    update: (next: CausalContext) => {
      ref.current = next
    },
  }
}

describe('createEnvelopeWrapper', () => {
  it('根事件：correlationId 注入、causationId=null、sequence=1', async () => {
    const counter = new SequenceCounter()
    const ctx = { current: CausalContext.root('corr_1') }
    const wrap = createEnvelopeWrapper({
      counter,
      contextProvider: makeRefProvider(ctx),
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
      contextProvider: makeRefProvider(ctx),
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
      contextProvider: makeRefProvider(ctx),
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
      contextProvider: makeRefProvider(ctx),
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

  it('跨聚合 sequence 互相隔离：Run:r1 与 Task:t1 各从 1 开始', async () => {
    const counter = new SequenceCounter()
    const ctx = { current: CausalContext.root('corr_x') }
    const wrap = createEnvelopeWrapper({
      counter,
      contextProvider: makeRefProvider(ctx),
      source: { processKind: 'daemon', processId: 'p1' },
      recoverer: NoopSequenceRecoverer,
      now: () => 'T',
    })

    const runEvent: RunStartedEvent = {
      type: 'RunStarted',
      runId: 'r1',
      sessionId: 's1',
      triggerType: 'fresh',
      timestamp: 0,
    }
    const taskEvent: TaskStartedEvent = {
      type: 'TaskStarted',
      taskId: 't1',
      timestamp: 0,
    }

    const runEnv = await wrap(runEvent)
    const taskEnv = await wrap(taskEvent)

    expect(runEnv.aggregateType).toBe('Run')
    expect(runEnv.aggregateId).toBe('r1')
    expect(runEnv.sequence).toBe(1)

    expect(taskEnv.aggregateType).toBe('Task')
    expect(taskEnv.aggregateId).toBe('t1')
    expect(taskEnv.sequence).toBe(1)
  })

  it('CausalContext.child propagation：causationId 正确写入 envelope', async () => {
    const counter = new SequenceCounter()
    const root = CausalContext.root('corr_1')
    const child = root.child('parent_event_id')
    const ctx = { current: child }
    const wrap = createEnvelopeWrapper({
      counter,
      contextProvider: makeRefProvider(ctx),
      source: { processKind: 'daemon', processId: 'p1' },
      recoverer: NoopSequenceRecoverer,
      now: () => 'T',
    })

    const env = await wrap({
      type: 'RunStarted',
      runId: 'r2',
      sessionId: 's2',
      triggerType: 'fresh',
      timestamp: 0,
    })

    expect(env.correlationId).toBe('corr_1')
    expect(env.causationId).toBe('parent_event_id')
  })

  it('并发 wrap 同一 aggregate key：recoverer 只调用一次，sequence 连续递增', async () => {
    const counter = new SequenceCounter()
    const ctx = { current: CausalContext.root('corr_c') }
    let recovererCallCount = 0

    const wrap = createEnvelopeWrapper({
      counter,
      contextProvider: makeRefProvider(ctx),
      source: { processKind: 'daemon', processId: 'p1' },
      recoverer: {
        maxSequence(): Promise<number | null> {
          recovererCallCount++
          // 模拟异步 IO：让出微任务队列一次，使并发路径均能进入 init 判断
          return new Promise<number | null>((resolve) => {
            queueMicrotask(() => resolve(0))
          })
        },
      },
      now: () => 'T',
    })

    const runEvent1: RunStartedEvent = {
      type: 'RunStarted',
      runId: 'r1',
      sessionId: 's1',
      triggerType: 'fresh',
      timestamp: 0,
    }
    const runEvent2: RunStartedEvent = {
      type: 'RunStarted',
      runId: 'r1',
      sessionId: 's1',
      triggerType: 'resume',
      timestamp: 1,
    }

    const [env1, env2] = await Promise.all([wrap(runEvent1), wrap(runEvent2)])

    // recoverer 只应被调用一次
    expect(recovererCallCount).toBe(1)

    // 两个 envelope 都成功生成
    expect(env1.aggregateType).toBe('Run')
    expect(env2.aggregateType).toBe('Run')

    // sequence 连续且互不重复
    const sequences = new Set([env1.sequence, env2.sequence])
    expect(sequences.size).toBe(2)
    expect(Math.min(env1.sequence, env2.sequence)).toBe(1)
    expect(Math.max(env1.sequence, env2.sequence)).toBe(2)
  })
})
