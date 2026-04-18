/**
 * orchestration e2e 测试。
 *
 * 业务职责：
 * - 验证 runOrchestrationGraph + createDeepagentsExecutorFactory 能完整跑通多节点编排，并广播图级事件。
 * - 图编译和 graph-runner 走真实链路；部分用例会 mock createSessionRuntime，把节点 usage 固定到可预测值。
 */
import { FakeListChatModel } from '@langchain/core/utils/testing'
import type { SessionRuntime } from '@tianji/runtime'
import * as runtimeModule from '@tianji/runtime'
import type { DomainEvent, GraphRunDomainEvent, RunId, SessionId, TokenUsage } from '@tianji/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDeepagentsExecutorFactory } from '../executors/deepagents-executor.js'
import { runOrchestrationGraph } from '../graph-runner.js'
import type { OrchestrationGraph } from '../graph-schema.js'

afterEach(() => {
  vi.restoreAllMocks()
})

interface MockNodeRun {
  readonly text: string
  readonly usage: TokenUsage
}

function mockRuntimeUsageSequence(nodeRuns: readonly MockNodeRun[]): void {
  let runtimeIndex = 0
  vi.spyOn(runtimeModule, 'createSessionRuntime').mockImplementation(() => {
    const currentIndex = runtimeIndex
    const currentRun = nodeRuns[currentIndex]
    if (currentRun === undefined) {
      throw new Error(`missing mock node run for runtime #${currentIndex + 1}`)
    }
    runtimeIndex += 1

    const sessionId = `session_${currentIndex + 1}` as SessionId
    const runId = `run_${currentIndex + 1}` as RunId

    return {
      createSession: vi.fn(async () => ({
        sessionId,
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 },
        },
      })),
      openSession: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
      getSessionSnapshot: vi.fn(async () => ({
        sessionId,
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 },
        },
      })),
      getRunSnapshot: vi.fn(async () => ({
        runId,
        sessionId,
        status: 'completed',
        triggerType: 'new',
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        pendingOperations: [],
        metadata: {
          usage: currentRun.usage,
        },
      })),
      runTurn: vi.fn(async () => runId),
      resumeRun: vi.fn(async () => runId),
      cancelRun: vi.fn(() => false),
      streamEvents: vi.fn(async function* () {
        yield {
          type: 'MessageCompleted',
          runId,
          message: {
            id: `msg_${runId}`,
            role: 'assistant',
            content: [{ type: 'text', text: currentRun.text }],
            createdAt: Date.now(),
          },
          timestamp: Date.now(),
        } as DomainEvent
        yield {
          type: 'RunCompleted',
          runId,
          timestamp: Date.now(),
        } as DomainEvent
      }),
    } as unknown as SessionRuntime
  })
}

async function collectGraphEvents(
  graph: OrchestrationGraph,
  runId: RunId,
  factory: ReturnType<typeof createDeepagentsExecutorFactory>
): Promise<GraphRunDomainEvent[]> {
  const result = runOrchestrationGraph({
    graph,
    runId,
    compileOptions: { agentExecutorFactory: factory },
  })

  const events: GraphRunDomainEvent[] = []
  const collect = (async () => {
    for await (const event of result.events) {
      events.push(event as GraphRunDomainEvent)
    }
  })()

  await result.finished
  await collect
  return events
}

describe('orchestration e2e', () => {
  it('两节点串行管线 planner→coder', async () => {
    // FakeListChatModel.bindTools() 会克隆模型实例并把 i 重置在克隆体上独立递增。
    // deepagents 内部调用 bindTools 后，原实例的计数器与执行链分离，
    // 因此共享同一个实例无法在不同节点之间推进 responses 序列。
    // 解决方案：每次 resolveModel 被调用时按顺序发放下一条 response，
    // 让每个节点拿到只含自己那一条 response 的全新模型实例。
    const responses = ['plan: do A then B', 'code: console.log("done")']
    let responseIndex = 0
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => {
        const next = responses[responseIndex] ?? ''
        responseIndex += 1
        return new FakeListChatModel({ responses: [next] })
      },
    })

    const graph: OrchestrationGraph = {
      id: 'pipeline',
      name: 'planner-coder',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        plan: { type: 'string' },
        code: { type: 'string' },
      },
      nodes: [
        {
          id: 'planner',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: '你是规划者' },
          output: ['plan'],
        },
        {
          id: 'coder',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: '你是编码者' },
          input: ['plan'],
          output: ['code'],
        },
      ],
      edges: [
        { from: '__start__', to: 'planner' },
        { from: 'planner', to: 'coder' },
        { from: 'coder', to: '__end__' },
      ],
    }

    const mermaidDiagrams: string[] = []

    const result = runOrchestrationGraph({
      graph,
      runId: 'run_e2e_1' as RunId,
      compileOptions: { agentExecutorFactory: factory },
      onMermaid: (diagram) => {
        mermaidDiagrams.push(diagram)
      },
    })

    const collectedEvents: DomainEvent[] = []
    const collectionPromise = (async () => {
      for await (const event of result.events) {
        collectedEvents.push(event)
      }
    })()

    const finalState = await result.finished
    await collectionPromise

    expect(mermaidDiagrams).toHaveLength(1)
    expect(mermaidDiagrams[0]).toContain('flowchart TD')
    expect(mermaidDiagrams[0]).toContain('planner[agent: planner]')
    expect(mermaidDiagrams[0]).toContain('planner --> coder')

    expect(finalState.plan).toContain('plan')
    expect(finalState.code).toContain('console.log')

    const eventTypes = collectedEvents.map((event) => event.type)
    expect(eventTypes).toContain('GraphRunStarted')
    expect(eventTypes).toContain('GraphNodeStarted')
    expect(eventTypes).toContain('GraphNodeCompleted')
    expect(eventTypes).toContain('GraphRunCompleted')
  })

  it('router 形成循环：reviewer 不通过则回到 coder', async () => {
    // 序列：第一次 coder→ "代码 v1"； reviewer→ "{approved:false}"；
    //       第二次 coder→ "代码 v2"； reviewer→ "{approved:true}"。
    // 同样使用按调用发放 response 的策略，避免 bindTools 克隆隔离掉游标。
    const responses = [
      '代码 v1',
      '{"review":"待改进","approved":false}',
      '代码 v2',
      '{"review":"通过","approved":true}',
    ]
    let responseIndex = 0
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => {
        const next = responses[responseIndex] ?? ''
        responseIndex += 1
        return new FakeListChatModel({ responses: [next] })
      },
    })

    const graph: OrchestrationGraph = {
      id: 'review-loop',
      name: 'reviewer-loop',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        code: { type: 'string' },
        review: { type: 'string' },
        approved: { type: 'boolean', default: false },
      },
      nodes: [
        {
          id: 'coder',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: '编码者' },
          output: ['code'],
        },
        {
          id: 'reviewer',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: '审查者' },
          input: ['code'],
          output: ['review', 'approved'],
        },
        {
          id: 'router1',
          type: 'router',
          condition: {
            field: 'approved',
            branches: { true: '__end__', false: 'coder' },
          },
        },
      ],
      edges: [
        { from: '__start__', to: 'coder' },
        { from: 'coder', to: 'reviewer' },
        { from: 'reviewer', to: 'router1' },
      ],
    }

    const result = runOrchestrationGraph({
      graph,
      runId: 'run_e2e_loop' as RunId,
      compileOptions: { agentExecutorFactory: factory },
    })

    const events: DomainEvent[] = []
    const collect = (async () => {
      for await (const event of result.events) {
        events.push(event)
      }
    })()

    const finalState = await result.finished
    await collect

    expect(finalState.approved).toBe(true)
    expect(finalState.code).toBe('代码 v2')

    const coderStarts = events.filter(
      (event) =>
        event.type === 'GraphNodeStarted' && (event as { nodeId: string }).nodeId === 'coder'
    )
    expect(coderStarts.length).toBe(2) // 因为循环了一次
  })

  it('loop 图中同一节点多次成功时，GraphRunCompleted usage 会累计每次执行', async () => {
    mockRuntimeUsageSequence([
      { text: '代码 v1', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
      {
        text: '{"review":"待改进","approved":false}',
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      },
      { text: '代码 v2', usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 } },
      {
        text: '{"review":"通过","approved":true}',
        usage: { inputTokens: 17, outputTokens: 9, totalTokens: 26 },
      },
    ])
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['unused'] }),
    })
    const graph: OrchestrationGraph = {
      id: 'review-loop-usage',
      name: 'review-loop-usage',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        code: { type: 'string' },
        review: { type: 'string' },
        approved: { type: 'boolean', default: false },
      },
      nodes: [
        {
          id: 'coder',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: '编码者' },
          output: ['code'],
        },
        {
          id: 'reviewer',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: '审查者' },
          input: ['code'],
          output: ['review', 'approved'],
        },
        {
          id: 'router1',
          type: 'router',
          condition: {
            field: 'approved',
            branches: { true: '__end__', false: 'coder' },
          },
        },
      ],
      edges: [
        { from: '__start__', to: 'coder' },
        { from: 'coder', to: 'reviewer' },
        { from: 'reviewer', to: 'router1' },
      ],
    }

    const events = await collectGraphEvents(graph, 'run_usage_loop' as RunId, factory)
    const graphCompleted = events.find((event) => event.type === 'GraphRunCompleted')

    expect(graphCompleted).toMatchObject({
      usage: { inputTokens: 36, outputTokens: 17, totalTokens: 53 },
    })
  })

  it('单节点 graph 的 GraphRunCompleted usage 等于 GraphNodeCompleted usage', async () => {
    mockRuntimeUsageSequence([
      { text: 'single result', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
    ])
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['unused'] }),
    })
    const graph: OrchestrationGraph = {
      id: 'single-usage',
      name: 'single-usage',
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
          agent: { model: 'fake', systemPrompt: 'worker' },
          output: ['result'],
        },
      ],
      edges: [
        { from: '__start__', to: 'worker' },
        { from: 'worker', to: '__end__' },
      ],
    }

    const events = await collectGraphEvents(graph, 'run_usage_single' as RunId, factory)
    const nodeCompleted = events.find((event) => event.type === 'GraphNodeCompleted')
    const graphCompleted = events.find((event) => event.type === 'GraphRunCompleted')

    expect(nodeCompleted).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    })
    expect(graphCompleted).toMatchObject({
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    })
  })

  it('两节点串行 graph 的 GraphRunCompleted usage 等于节点 usage 之和', async () => {
    mockRuntimeUsageSequence([
      { text: 'plan result', usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
      { text: 'code result', usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 } },
    ])
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['unused'] }),
    })
    const graph: OrchestrationGraph = {
      id: 'serial-usage',
      name: 'serial-usage',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        plan: { type: 'string' },
        code: { type: 'string' },
      },
      nodes: [
        {
          id: 'planner',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: 'planner' },
          output: ['plan'],
        },
        {
          id: 'coder',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: 'coder' },
          input: ['plan'],
          output: ['code'],
        },
      ],
      edges: [
        { from: '__start__', to: 'planner' },
        { from: 'planner', to: 'coder' },
        { from: 'coder', to: '__end__' },
      ],
    }

    const events = await collectGraphEvents(graph, 'run_usage_serial' as RunId, factory)
    const graphCompleted = events.find((event) => event.type === 'GraphRunCompleted')

    expect(graphCompleted).toMatchObject({
      usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
    })
  })

  it('graph-level usage 会累加 cache token 字段', async () => {
    mockRuntimeUsageSequence([
      {
        text: 'plan result',
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
          cacheReadTokens: 3,
          cacheCreationTokens: 1,
        },
      },
      {
        text: 'code result',
        usage: {
          inputTokens: 20,
          outputTokens: 8,
          totalTokens: 28,
          cacheReadTokens: 7,
          cacheCreationTokens: 2,
        },
      },
    ])
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['unused'] }),
    })
    const graph: OrchestrationGraph = {
      id: 'serial-cache-usage',
      name: 'serial-cache-usage',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        plan: { type: 'string' },
        code: { type: 'string' },
      },
      nodes: [
        {
          id: 'planner',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: 'planner' },
          output: ['plan'],
        },
        {
          id: 'coder',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: 'coder' },
          input: ['plan'],
          output: ['code'],
        },
      ],
      edges: [
        { from: '__start__', to: 'planner' },
        { from: 'planner', to: 'coder' },
        { from: 'coder', to: '__end__' },
      ],
    }

    const events = await collectGraphEvents(graph, 'run_usage_cache' as RunId, factory)
    const graphCompleted = events.find((event) => event.type === 'GraphRunCompleted')

    expect(graphCompleted).toMatchObject({
      usage: {
        inputTokens: 30,
        outputTokens: 12,
        totalTokens: 42,
        cacheReadTokens: 10,
        cacheCreationTokens: 3,
      },
    })
  })

  it('fork 并行 graph 的 GraphRunCompleted usage 等于所有节点 usage 之和', async () => {
    mockRuntimeUsageSequence([
      { text: 'start', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
      { text: 'left', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      { text: 'right', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } },
      { text: 'merge', usage: { inputTokens: 15, outputTokens: 6, totalTokens: 21 } },
    ])
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['unused'] }),
    })
    const graph: OrchestrationGraph = {
      id: 'fork-usage',
      name: 'fork-usage',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        logs: { type: 'list', reducer: 'append', default: [] },
      },
      nodes: [
        {
          id: 'start_node',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: 'start' },
          output: ['logs'],
        },
        {
          id: 'left',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: 'left' },
          output: ['logs'],
        },
        {
          id: 'right',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: 'right' },
          output: ['logs'],
        },
        {
          id: 'merge',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: 'merge' },
          output: ['logs'],
        },
        {
          id: 'fork1',
          type: 'fork',
          targets: ['left', 'right'],
          join: 'merge',
        },
      ],
      edges: [
        { from: '__start__', to: 'start_node' },
        { from: 'start_node', to: 'fork1' },
        { from: 'merge', to: '__end__' },
      ],
    }

    const events = await collectGraphEvents(graph, 'run_usage_fork' as RunId, factory)
    const graphCompleted = events.find((event) => event.type === 'GraphRunCompleted')

    expect(graphCompleted).toMatchObject({
      usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
    })
  })
})
