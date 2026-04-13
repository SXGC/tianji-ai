import { describe, expect, it } from 'vitest'

import { renderOrchestrationGraphMermaid } from '../graph-mermaid.js'
import type { OrchestrationGraph } from '../graph-schema.js'

describe('renderOrchestrationGraphMermaid', () => {
  it('渲染串行 agent 管线为 mermaid flowchart', () => {
    const graph: OrchestrationGraph = {
      id: 'pipeline',
      name: 'pipeline',
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

    const result = renderOrchestrationGraphMermaid(graph)

    expect(result).toContain('flowchart TD')
    expect(result).toContain('__start__([START])')
    expect(result).toContain('__end__([END])')
    expect(result).toContain('planner[agent: planner]')
    expect(result).toContain('coder[agent: coder]')
    expect(result).toContain('__start__ --> planner')
    expect(result).toContain('planner --> coder')
    expect(result).toContain('coder --> __end__')
  })

  it('按节点类型渲染不同 mermaid 形状', () => {
    const graph: OrchestrationGraph = {
      id: 'mixed',
      name: 'mixed',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        approved: { type: 'boolean', default: false },
      },
      nodes: [
        {
          id: 'worker-acp',
          type: 'acp-agent',
          acp: { command: 'tianji-agent' },
        },
        {
          id: 'review-router',
          type: 'router',
          condition: { field: 'approved', branches: { true: '__end__', false: 'worker-acp' } },
        },
        {
          id: 'approval-gate',
          type: 'human-gate',
          prompt: '继续吗',
        },
        {
          id: 'parallel-work',
          type: 'fork',
          targets: ['worker-acp'],
          join: 'approval-gate',
        },
      ],
      edges: [
        { from: '__start__', to: 'parallel-work' },
        { from: 'worker-acp', to: 'review-router' },
        { from: 'approval-gate', to: '__end__' },
      ],
    }

    const result = renderOrchestrationGraphMermaid(graph)

    expect(result).toContain('worker_acp[[acp: worker-acp]]')
    expect(result).toContain('review_router{router: review-router}')
    expect(result).toContain('approval_gate{{human: approval-gate}}')
    expect(result).toContain('parallel_work([fork: parallel-work])')
  })
})
