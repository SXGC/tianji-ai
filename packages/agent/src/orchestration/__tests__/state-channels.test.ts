/**
 * state-channels 行为测试。
 *
 * 业务职责：验证 compileStateChannels 产出的 channel reducer 在真正的
 * LangGraph StateGraph 中表现符合预期。测试的是 reducer 的"业务行为"
 * （写覆盖 / 追加 / 合并 / 报错），而非 annotation.spec 的键是否存在。
 */
import { END, START, StateGraph } from '@langchain/langgraph'
import { describe, expect, it } from 'vitest'

import { compileStateChannels } from '../state-channels'

/**
 * 构造一个最小的单节点 StateGraph：
 *  - 节点名为 "mutator"，返回传入的 update；
 *  - 边结构为 START -> mutator -> END；
 *  - compile 并 invoke 后返回最终 state，用于断言 reducer 行为。
 */
async function runSingleNodeWithUpdate(
  channels: Parameters<typeof compileStateChannels>[0],
  initial: Record<string, unknown>,
  update: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const annotation = compileStateChannels(channels)
  // langgraph 的 StateGraph 泛型比我们需要的严格太多，借助 unknown 逃逸。
  const graph = new StateGraph(annotation as never) as unknown as {
    addNode: (id: string, action: () => Promise<Record<string, unknown>>) => unknown
    addEdge: (from: string, to: string) => unknown
    compile: () => {
      invoke: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
  }
  graph.addNode('mutator', async () => update)
  graph.addEdge(START, 'mutator')
  graph.addEdge('mutator', END)
  const compiled = graph.compile()
  return compiled.invoke(initial)
}

describe('compileStateChannels', () => {
  it('replace reducer 后写覆盖前值', async () => {
    const final = await runSingleNodeWithUpdate(
      { title: { type: 'string', reducer: 'replace' } },
      { title: 'first' },
      { title: 'second' }
    )
    expect(final.title).toBe('second')
  })

  it('append reducer 把新值拼接到现有列表', async () => {
    const final = await runSingleNodeWithUpdate(
      { messages: { type: 'list', reducer: 'append' } },
      { messages: ['a'] },
      { messages: ['b', 'c'] }
    )
    expect(final.messages).toEqual(['a', 'b', 'c'])
  })

  it('append reducer 接受单个非数组值并拼接', async () => {
    const final = await runSingleNodeWithUpdate(
      { messages: { type: 'list', reducer: 'append' } },
      { messages: ['a'] },
      // 节点返回单值；reducer 内部会自动包装为数组。
      { messages: 'b' as unknown as never }
    )
    expect(final.messages).toEqual(['a', 'b'])
  })

  it('merge reducer 浅合并对象', async () => {
    const final = await runSingleNodeWithUpdate(
      { ctx: { type: 'object', reducer: 'merge' } },
      { ctx: { a: 1 } },
      { ctx: { b: 2 } }
    )
    expect(final.ctx).toEqual({ a: 1, b: 2 })
  })

  it('merge reducer 后写字段覆盖前值', async () => {
    const final = await runSingleNodeWithUpdate(
      { ctx: { type: 'object', reducer: 'merge' } },
      { ctx: { a: 1, b: 2 } },
      { ctx: { b: 99 } }
    )
    expect(final.ctx).toEqual({ a: 1, b: 99 })
  })

  it('缺省 reducer 等价于 replace', async () => {
    const final = await runSingleNodeWithUpdate(
      { flag: { type: 'boolean' } },
      { flag: false },
      { flag: true }
    )
    expect(final.flag).toBe(true)
  })

  it('append reducer 的默认值是空数组（不传 initial 时不丢前值）', async () => {
    const final = await runSingleNodeWithUpdate(
      { messages: { type: 'list', reducer: 'append' } },
      {},
      { messages: ['only'] }
    )
    expect(final.messages).toEqual(['only'])
  })

  it('对未知 reducer 类型抛错', () => {
    expect(() =>
      compileStateChannels({
        bad: { type: 'string', reducer: 'unknown' as never },
      })
    ).toThrow(/未知的 reducer/)
  })
})
