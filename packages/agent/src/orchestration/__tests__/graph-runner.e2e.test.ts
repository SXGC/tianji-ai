/**
 * orchestration e2e 测试。
 *
 * 业务职责：
 * - 验证 runOrchestrationGraph + 真实 createDeepagentsExecutorFactory + FakeListChatModel
 *   能完整跑通一个多节点编排，并广播图级事件。
 * - 不使用任何 mock：走完整的 graph-runner / graph-compiler / deepagents-executor 路径。
 */
import { FakeListChatModel } from '@langchain/core/utils/testing'
import type { RunId, RuntimeEvent } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createDeepagentsExecutorFactory } from '../executors/deepagents-executor.js'
import { runOrchestrationGraph } from '../graph-runner.js'
import type { OrchestrationGraph } from '../graph-schema.js'

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

    const collectedEvents: RuntimeEvent[] = []
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
    expect(eventTypes).toContain('graph.started')
    expect(eventTypes).toContain('graph.node.started')
    expect(eventTypes).toContain('graph.node.completed')
    expect(eventTypes).toContain('graph.completed')
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

    const events: RuntimeEvent[] = []
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
        event.type === 'graph.node.started' && (event as { nodeId: string }).nodeId === 'coder'
    )
    expect(coderStarts.length).toBe(2) // 因为循环了一次
  })
})
