/**
 * resolveAgentModel 单元测试。
 *
 * 业务职责：
 * - 覆盖 executor 路径上 `provider/modelName` 的解析规则。
 * - 验证自定义 baseUrl 场景会预实例化 ChatOpenAI，而默认场景返回 `provider:modelName` 字符串。
 */
import { ChatOpenAI } from '@langchain/openai'
import { describe, expect, it } from 'vitest'

import { resolveAgentModel } from '../model-resolver.js'

describe('resolveAgentModel', () => {
  it('returns provider:modelName string when no provider config is present', () => {
    const resolved = resolveAgentModel('openai/gpt-4o-mini', undefined)

    expect(resolved).toBe('openai:gpt-4o-mini')
  })

  it('returns provider:modelName string when provider config lacks baseUrl and headers', () => {
    const resolved = resolveAgentModel('openai/gpt-4o-mini', {
      openai: { apiKey: 'sk-test' },
    })

    expect(resolved).toBe('openai:gpt-4o-mini')
  })

  it('returns ChatOpenAI instance when openai provider has a custom baseUrl', () => {
    const resolved = resolveAgentModel('openai/glm-latest', {
      openai: {
        apiKey: 'sk-test',
        baseUrl: 'http://127.0.0.1:8317/v1',
      },
    })

    expect(resolved).toBeInstanceOf(ChatOpenAI)
    const instance = resolved as ChatOpenAI
    expect(instance.model).toBe('glm-latest')
  })

  it('returns ChatOpenAI instance when openai provider has only custom headers', () => {
    const resolved = resolveAgentModel('openai/gpt-4o-mini', {
      openai: {
        apiKey: 'sk-test',
        headers: { 'x-custom': 'yes' },
      },
    })

    expect(resolved).toBeInstanceOf(ChatOpenAI)
  })

  it('returns provider:modelName string for non-openai providers even with baseUrl', () => {
    // 业务边界：当前仅 OpenAI SDK 支持通过 configuration 注入 baseURL。
    // 其他 provider 需要按 provider 扩展分派，而不应静默降级为 OpenAI 实例。
    const resolved = resolveAgentModel('anthropic/claude-3-7-sonnet', {
      anthropic: {
        apiKey: 'sk-anth',
        baseUrl: 'http://custom/v1',
      },
    })

    expect(resolved).toBe('anthropic:claude-3-7-sonnet')
  })

  it('ignores non-string baseUrl and non-object headers', () => {
    // passthrough 配置允许任意字段，解析器必须对类型不合法的值保持健壮。
    const resolved = resolveAgentModel('openai/gpt-4o-mini', {
      openai: {
        apiKey: 'sk-test',
        // 故意写成非法类型，验证函数不会因此构造错误的 ChatOpenAI
        baseUrl: 123 as unknown as string,
        headers: 'not-an-object' as unknown as Record<string, string>,
      },
    })

    expect(resolved).toBe('openai:gpt-4o-mini')
  })

  it('filters out non-string header values', () => {
    const resolved = resolveAgentModel('openai/gpt-4o-mini', {
      openai: {
        apiKey: 'sk-test',
        headers: {
          'x-valid': 'yes',
          'x-invalid': 123 as unknown as string,
        },
      },
    })

    expect(resolved).toBeInstanceOf(ChatOpenAI)
  })
})
