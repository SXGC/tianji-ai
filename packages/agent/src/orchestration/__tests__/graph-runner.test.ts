/**
 * graph-runner 单元/集成测试。
 *
 * 业务职责：
 * - 验证 AbortError 路径：中止信号触发时发 GraphRunCancelled，不发 GraphRunFailed。
 * - 验证错误路径：真实异常时发 GraphRunFailed，不发 GraphRunCancelled。
 */
import { FakeListChatModel } from '@langchain/core/utils/testing'
import type { DomainEvent, RunId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createDeepagentsExecutorFactory } from '../executors/deepagents-executor.js'
import { runOrchestrationGraph } from '../graph-runner.js'
import type { OrchestrationGraph } from '../graph-schema.js'

/** 构造最小单节点图，足以驱动 graph-runner 进入 invoke */
function buildMinimalGraph(): OrchestrationGraph {
  return {
    id: 'test-graph',
    name: 'test',
    version: 1,
    source: 'static',
    locked: false,
    state: {
      result: { type: 'string' },
    },
    nodes: [
      {
        id: 'worker',
        type: 'agent',
        agent: { model: 'fake', systemPrompt: '你是一个工作者' },
        output: ['result'],
      },
    ],
    edges: [
      { from: '__start__', to: 'worker' },
      { from: 'worker', to: '__end__' },
    ],
  }
}

/**
 * 收集事件流中所有事件，直到流结束。
 * 调用此函数前不要 await finished，让两者并发推进。
 */
async function collectEvents(events: AsyncIterable<DomainEvent>): Promise<DomainEvent[]> {
  const collected: DomainEvent[] = []
  for await (const event of events) {
    collected.push(event)
  }
  return collected
}

describe('graph-runner AbortError 语义', () => {
  it('预先 abort 的 signal 应产生 GraphRunCancelled 而非 GraphRunFailed', async () => {
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['result value'] }),
    })

    const controller = new AbortController()
    // 预先中止，invoke 开始即遇到已 aborted 的 signal
    controller.abort()

    const result = runOrchestrationGraph({
      graph: buildMinimalGraph(),
      runId: 'run_abort_test' as RunId,
      compileOptions: { agentExecutorFactory: factory },
      abortSignal: controller.signal,
    })

    // 并发收集事件与等待 finished
    const collectionPromise = collectEvents(result.events)

    // finished 应该 reject（LangGraph 会抛出 AbortError）
    await expect(result.finished).rejects.toThrow()

    const collectedEvents = await collectionPromise
    const eventTypes = collectedEvents.map((e) => e.type)

    expect(eventTypes).toContain('GraphRunCancelled')
    expect(eventTypes).not.toContain('GraphRunFailed')
  })
})

describe('graph-runner 普通错误语义', () => {
  it('非 AbortError 异常应产生 GraphRunFailed 而非 GraphRunCancelled', async () => {
    // 强制 resolveModel 抛错，模拟 executor 初始化失败
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => {
        throw new Error('model initialization failed')
      },
    })

    const result = runOrchestrationGraph({
      graph: buildMinimalGraph(),
      runId: 'run_fail_test' as RunId,
      compileOptions: { agentExecutorFactory: factory },
    })

    const collectionPromise = collectEvents(result.events)

    // finished 应该 reject
    await expect(result.finished).rejects.toThrow()

    const collectedEvents = await collectionPromise
    const eventTypes = collectedEvents.map((e) => e.type)

    expect(eventTypes).toContain('GraphRunFailed')
    expect(eventTypes).not.toContain('GraphRunCancelled')
  })
})
