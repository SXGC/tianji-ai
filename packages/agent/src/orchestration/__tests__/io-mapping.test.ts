import { describe, expect, it } from 'vitest'
import {
  buildOutputInstructionSuffix,
  buildPromptFromState,
  buildStateUpdateFromText,
} from '../io-mapping.js'

describe('buildPromptFromState', () => {
  it('input 为空时返回空字符串', () => {
    expect(buildPromptFromState({}, undefined)).toBe('')
    expect(buildPromptFromState({ x: 'y' }, [])).toBe('')
  })

  it('单字段直接返回字符串值', () => {
    expect(buildPromptFromState({ task: 'hello' }, ['task'])).toBe('hello')
  })

  it('单字段非字符串时 JSON.stringify', () => {
    expect(buildPromptFromState({ data: { a: 1 } }, ['data'])).toBe('{"a":1}')
  })

  it('多字段拼接为带 markdown 标题的段落', () => {
    const out = buildPromptFromState({ plan: 'P', code: 'C' }, ['plan', 'code'])
    expect(out).toContain('## plan')
    expect(out).toContain('P')
    expect(out).toContain('## code')
    expect(out).toContain('C')
  })

  it('字段不存在于 state 时抛错（Let it crash）', () => {
    expect(() => buildPromptFromState({ a: 'x' }, ['ghost'])).toThrow(/ghost/)
  })
})

describe('buildStateUpdateFromText', () => {
  it('output 为空时返回空对象', () => {
    expect(buildStateUpdateFromText('result', undefined)).toEqual({})
    expect(buildStateUpdateFromText('result', [])).toEqual({})
  })

  it('单字段把整个文本写到该字段', () => {
    expect(buildStateUpdateFromText('hello', ['out'])).toEqual({ out: 'hello' })
  })

  it('多字段尝试解析 JSON 并按字段分配', () => {
    const text = '{"code":"C","tests":"T"}'
    expect(buildStateUpdateFromText(text, ['code', 'tests'])).toEqual({
      code: 'C',
      tests: 'T',
    })
  })

  it('多字段时 JSON 不合法则抛错', () => {
    expect(() => buildStateUpdateFromText('not json', ['a', 'b'])).toThrow(/JSON/)
  })

  it('多字段时 JSON 缺少字段则抛错', () => {
    expect(() => buildStateUpdateFromText('{"a":1}', ['a', 'b'])).toThrow(/b/)
  })

  it('多字段时 JSON 包裹在 markdown code fence 中也能解析', () => {
    const text = '```json\n{"a":"x","b":"y"}\n```'
    expect(buildStateUpdateFromText(text, ['a', 'b'])).toEqual({ a: 'x', b: 'y' })
  })
})

describe('buildOutputInstructionSuffix', () => {
  it('output 为空或单字段时返回空字符串', () => {
    expect(buildOutputInstructionSuffix(undefined)).toBe('')
    expect(buildOutputInstructionSuffix(['only'])).toBe('')
  })

  it('多字段返回 JSON 输出指令', () => {
    const suffix = buildOutputInstructionSuffix(['code', 'tests'])
    expect(suffix).toContain('JSON')
    expect(suffix).toContain('code')
    expect(suffix).toContain('tests')
  })
})
