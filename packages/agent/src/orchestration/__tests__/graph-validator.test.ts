import { describe, expect, it } from 'vitest'
import type { OrchestrationGraph } from '../graph-schema'
import { validateOrchestrationGraph } from '../graph-validator'

function makeGraph(overrides: Partial<OrchestrationGraph> = {}): OrchestrationGraph {
  return {
    id: 'g1',
    name: 'test',
    version: 1,
    source: 'static',
    locked: false,
    state: { messages: { type: 'list', reducer: 'append' } },
    nodes: [
      {
        id: 'a',
        type: 'agent',
        agent: { model: 'fake', systemPrompt: 'sp' },
      },
    ],
    edges: [
      { from: '__start__', to: 'a' },
      { from: 'a', to: '__end__' },
    ],
    ...overrides,
  }
}

describe('validateOrchestrationGraph', () => {
  it('接受有效的最小图', () => {
    const result = validateOrchestrationGraph(makeGraph())
    expect(result.ok).toBe(true)
  })

  it('拒绝缺少 __start__ 入边的图', () => {
    const result = validateOrchestrationGraph(makeGraph({ edges: [{ from: 'a', to: '__end__' }] }))
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/__start__/)
  })

  it('拒绝包含孤立节点的图', () => {
    const result = validateOrchestrationGraph(
      makeGraph({
        nodes: [
          { id: 'a', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
          { id: 'orphan', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
        ],
      })
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('orphan'))).toBe(true)
  })

  it('拒绝 router branches 指向不存在的节点', () => {
    const result = validateOrchestrationGraph(
      makeGraph({
        nodes: [
          { id: 'a', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
          {
            id: 'r',
            type: 'router',
            condition: { field: 'x', branches: { yes: 'ghost', no: '__end__' } },
          },
        ],
        edges: [
          { from: '__start__', to: 'a' },
          { from: 'a', to: 'r' },
        ],
      })
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('ghost'))).toBe(true)
  })

  it('拒绝 fork.targets 指向不存在的节点', () => {
    const result = validateOrchestrationGraph(
      makeGraph({
        nodes: [
          { id: 'a', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
          { id: 'b', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
          { id: 'f', type: 'fork', targets: ['b', 'missing'], join: 'b' },
        ],
        edges: [
          { from: '__start__', to: 'a' },
          { from: 'a', to: 'f' },
        ],
      })
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('missing'))).toBe(true)
  })

  it('拒绝节点 id 使用保留字', () => {
    const result = validateOrchestrationGraph(
      makeGraph({
        nodes: [
          {
            id: '__start__' as string,
            type: 'agent',
            agent: { model: 'fake', systemPrompt: 'sp' },
          } as never,
        ],
      })
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('保留'))).toBe(true)
  })

  it('拒绝 LLM 修改 locked 图（外部约定，不在此校验）', () => {
    // locked 字段权限校验应在外层（图编辑入口）做，validator 只校验结构。
    const result = validateOrchestrationGraph(makeGraph({ locked: true }))
    expect(result.ok).toBe(true)
  })
})
