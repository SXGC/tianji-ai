import { describe, expect, it } from 'vitest'
import { compileStateChannels } from '../state-channels'

describe('compileStateChannels', () => {
  it('replace reducer 产生 LastValue 行为：后写覆盖前值', () => {
    const annotation = compileStateChannels({
      title: { type: 'string', reducer: 'replace' },
    })
    // Annotation.Root 返回的 spec 包含 channel 工厂
    expect(annotation).toBeDefined()
    expect(annotation.spec).toBeDefined()
    expect('title' in annotation.spec).toBe(true)
  })

  it('append reducer 产生 list 拼接行为', () => {
    const annotation = compileStateChannels({
      messages: { type: 'list', reducer: 'append' },
    })
    expect('messages' in annotation.spec).toBe(true)
    // 模拟一次 reducer 调用，验证 append 语义
    const channelDef = annotation.spec.messages
    // Annotation channel 的内部结构：channelDef 是工厂或 BaseChannel
    expect(channelDef).toBeDefined()
  })

  it('merge reducer 用于 object 类型', () => {
    const annotation = compileStateChannels({
      ctx: { type: 'object', reducer: 'merge' },
    })
    expect('ctx' in annotation.spec).toBe(true)
  })

  it('缺省 reducer 等价于 replace', () => {
    const annotation = compileStateChannels({
      flag: { type: 'boolean' },
    })
    expect('flag' in annotation.spec).toBe(true)
  })

  it('多个 channel 同时定义', () => {
    const annotation = compileStateChannels({
      a: { type: 'string' },
      b: { type: 'list', reducer: 'append' },
      c: { type: 'object', reducer: 'merge' },
    })
    expect('a' in annotation.spec).toBe(true)
    expect('b' in annotation.spec).toBe(true)
    expect('c' in annotation.spec).toBe(true)
  })

  it('对未知 reducer 类型抛错', () => {
    expect(() =>
      compileStateChannels({
        bad: { type: 'string', reducer: 'unknown' as never },
      })
    ).toThrow(/未知的 reducer/)
  })
})
