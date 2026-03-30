/**
 * CLI 测试辅助工具。
 *
 * 为 CLI 测试统一提供 fake context 构造、runtime 包装与 stdout 捕获能力。
 */
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { type SessionRuntime, createSessionRuntime } from '@tianji/runtime'

import type { LoadedUserConfigContext } from '../../config.js'

/**
 * 构造最小可用的 LoadedUserConfigContext，用于测试注入。
 *
 * @param overrides - 需要覆盖的字段
 * @returns 测试用的用户配置上下文
 */
export function createFakeContext(
  overrides: Partial<LoadedUserConfigContext> = {}
): LoadedUserConfigContext {
  return {
    paths: {
      configDir: '/tmp/tianji-test/config',
      agentsDir: '/tmp/tianji-test/config/agents',
      logsDir: '/tmp/tianji-test/config/logs',
      configFilePath: '/tmp/tianji-test/config/tianji.json',
      cliLogFilePath: '/tmp/tianji-test/config/logs/cli.jsonl',
    },
    config: {},
    agent: {
      agentName: 'default',
      modelRef: 'openai/gpt-4.1',
      provider: 'openai',
      modelName: 'gpt-4.1',
      providerConfig: undefined,
      soulPath: '/tmp/tianji-test/config/agents/default/SOUL.md',
      soul: '# Test Agent\n\nYou are a test agent.\n',
    },
    resolvedEnvVars: [],
    ...overrides,
  }
}

/**
 * 使用 FakeListChatModel 创建 runtime，用于不需要真实 LLM 的测试。
 *
 * @param responses - fake model 返回的响应列表
 * @returns createRuntime 函数，可直接传给 handleRunCommand 的 deps
 */
export function createFakeRuntimeFactory(
  responses: readonly string[]
): (context: LoadedUserConfigContext) => SessionRuntime {
  return (_context: LoadedUserConfigContext) => {
    const fakeModel = new FakeListChatModel({ responses: [...responses] })

    return createSessionRuntime({
      deepagents: { model: fakeModel },
    })
  }
}

/**
 * 捕获 process.stdout.write 的输出。
 *
 * @param fn - 需要捕获 stdout 的异步函数
 * @returns 捕获到的完整输出文本
 */
export async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)

  const spy = (chunk: unknown): boolean => {
    if (typeof chunk === 'string') {
      chunks.push(chunk)
    }
    return true
  }

  process.stdout.write = spy as typeof process.stdout.write

  try {
    await fn()
  } finally {
    process.stdout.write = originalWrite
  }

  return chunks.join('')
}
