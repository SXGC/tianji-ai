/**
 * graph-runner 单元/集成测试。
 *
 * 业务职责：
 * - 验证 AbortError 路径：中止信号触发时发 GraphRunCancelled，不发 GraphRunFailed。
 * - 验证错误路径：真实异常时发 GraphRunFailed，不发 GraphRunCancelled。
 */
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { type DomainEvent, type GraphRunDomainEvent, type RunId, TianjiError } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createDeepagentsExecutorFactory } from '../executors/deepagents-executor.js'
import type {
  AgentExecutorFactory,
  NodeAction,
  NodeExecutorContext,
} from '../executors/executor-types.js'
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

describe('graph-runner GraphRunStarted mermaidDiagram', () => {
  it('GraphRunStarted 事件应包含非空的 mermaidDiagram 字段', async () => {
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['result value'] }),
    })

    const result = runOrchestrationGraph({
      graph: buildMinimalGraph(),
      runId: 'run_mermaid_test' as RunId,
      compileOptions: { agentExecutorFactory: factory },
    })

    const collectionPromise = collectEvents(result.events)
    await result.finished
    const collected = await collectionPromise

    const startedEvent = collected.find((e) => e.type === 'GraphRunStarted')
    expect(startedEvent).toBeDefined()
    // mermaidDiagram 由 renderOrchestrationGraphMermaid 生成，以 'flowchart' 开头
    expect((startedEvent as { type: string; mermaidDiagram: string }).mermaidDiagram).toMatch(
      /^flowchart/
    )
  })
})

describe('graph-runner terminal usage', () => {
  it('GraphNodeFailed.usage 会累计进 GraphRunFailed.usage', async () => {
    const failedUsage = {
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      cacheReadTokens: 3,
      cacheCreationTokens: 1,
    }
    const factory: AgentExecutorFactory =
      (node, ctx: NodeExecutorContext): NodeAction =>
      async () => {
        ctx.emitGraphEvent({
          type: 'GraphNodeFailed',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'agent',
          error: new TianjiError('internal', 'TEST', 'boom'),
          usage: failedUsage,
          timestamp: Date.now(),
        })
        throw new Error('boom')
      }

    const result = runOrchestrationGraph({
      graph: buildMinimalGraph(),
      runId: 'run_failed_usage_test' as RunId,
      compileOptions: { agentExecutorFactory: factory },
    })

    const collectionPromise = collectEvents(result.events)
    await expect(result.finished).rejects.toThrow('boom')
    const collectedEvents = (await collectionPromise) as GraphRunDomainEvent[]
    const graphFailed = collectedEvents.find((event) => event.type === 'GraphRunFailed')

    expect(graphFailed).toMatchObject({
      usage: failedUsage,
    })
  })

  it('GraphNodeCompleted.usage 和 GraphNodeFailed.usage 会共同累计进 GraphRunFailed.usage', async () => {
    const completedUsage = {
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 3,
      cacheReadTokens: 1,
      cacheCreationTokens: 1,
    }
    const failedUsage = {
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      cacheReadTokens: 3,
      cacheCreationTokens: 1,
    }
    const factory: AgentExecutorFactory =
      (node, ctx: NodeExecutorContext): NodeAction =>
      async () => {
        ctx.emitGraphEvent({
          type: 'GraphNodeCompleted',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'agent',
          output: { result: 'partial' },
          usage: completedUsage,
          timestamp: Date.now(),
        })
        ctx.emitGraphEvent({
          type: 'GraphNodeFailed',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'agent',
          error: new TianjiError('internal', 'TEST', 'boom'),
          usage: failedUsage,
          timestamp: Date.now(),
        })
        throw new Error('boom')
      }

    const result = runOrchestrationGraph({
      graph: buildMinimalGraph(),
      runId: 'run_failed_mixed_usage_test' as RunId,
      compileOptions: { agentExecutorFactory: factory },
    })

    const collectionPromise = collectEvents(result.events)
    await expect(result.finished).rejects.toThrow('boom')
    const collectedEvents = (await collectionPromise) as GraphRunDomainEvent[]
    const graphFailed = collectedEvents.find((event) => event.type === 'GraphRunFailed')

    expect(graphFailed).toMatchObject({
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        cacheReadTokens: 4,
        cacheCreationTokens: 2,
      },
    })
  })

  it('GraphNodeFailed.usage 会累计进 GraphRunCancelled.usage', async () => {
    const failedUsage = {
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 13,
      cacheReadTokens: 6,
      cacheCreationTokens: 2,
    }
    const controller = new AbortController()
    const factory: AgentExecutorFactory =
      (node, ctx: NodeExecutorContext): NodeAction =>
      async () => {
        ctx.emitGraphEvent({
          type: 'GraphNodeFailed',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'agent',
          error: new TianjiError('internal', 'TEST', 'aborted'),
          usage: failedUsage,
          timestamp: Date.now(),
        })
        controller.abort()
        const abortError = new Error('aborted')
        abortError.name = 'AbortError'
        throw abortError
      }

    const result = runOrchestrationGraph({
      graph: buildMinimalGraph(),
      runId: 'run_cancelled_usage_test' as RunId,
      compileOptions: { agentExecutorFactory: factory },
      abortSignal: controller.signal,
    })

    const collectionPromise = collectEvents(result.events)
    await expect(result.finished).rejects.toThrow('aborted')
    const collectedEvents = (await collectionPromise) as GraphRunDomainEvent[]
    const graphCancelled = collectedEvents.find((event) => event.type === 'GraphRunCancelled')

    expect(graphCancelled).toMatchObject({
      usage: failedUsage,
    })
  })

  it('GraphNodeCompleted.usage 和 GraphNodeFailed.usage 会共同累计进 GraphRunCancelled.usage', async () => {
    const completedUsage = {
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
    }
    const failedUsage = {
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 13,
      cacheReadTokens: 6,
      cacheCreationTokens: 2,
    }
    const controller = new AbortController()
    const factory: AgentExecutorFactory =
      (node, ctx: NodeExecutorContext): NodeAction =>
      async () => {
        ctx.emitGraphEvent({
          type: 'GraphNodeCompleted',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'agent',
          output: { result: 'partial' },
          usage: completedUsage,
          timestamp: Date.now(),
        })
        ctx.emitGraphEvent({
          type: 'GraphNodeFailed',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'agent',
          error: new TianjiError('internal', 'TEST', 'aborted'),
          usage: failedUsage,
          timestamp: Date.now(),
        })
        controller.abort()
        const abortError = new Error('aborted')
        abortError.name = 'AbortError'
        throw abortError
      }

    const result = runOrchestrationGraph({
      graph: buildMinimalGraph(),
      runId: 'run_cancelled_mixed_usage_test' as RunId,
      compileOptions: { agentExecutorFactory: factory },
      abortSignal: controller.signal,
    })

    const collectionPromise = collectEvents(result.events)
    await expect(result.finished).rejects.toThrow('aborted')
    const collectedEvents = (await collectionPromise) as GraphRunDomainEvent[]
    const graphCancelled = collectedEvents.find((event) => event.type === 'GraphRunCancelled')

    expect(graphCancelled).toMatchObject({
      usage: {
        inputTokens: 13,
        outputTokens: 6,
        totalTokens: 19,
        cacheReadTokens: 8,
        cacheCreationTokens: 3,
      },
    })
  })
})
