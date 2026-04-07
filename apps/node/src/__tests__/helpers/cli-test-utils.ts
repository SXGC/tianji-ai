/**
 * CLI 测试辅助工具。
 *
 * 为 CLI 测试统一提供 fake context 构造、runtime 包装与 stdout 捕获能力。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { FileSnapshotStore, type SessionRuntime, createSessionRuntime } from '@tianji/runtime'
import type { RuntimeEvent } from '@tianji/shared'

import type { AgentRunner } from '../../acp/index.js'
import type { CliDependencies } from '../../commands/types.js'
import type { LoadedUserConfigContext } from '../../config.js'
import type { UserConfigPaths } from '../../config.js'

type CliTestLocale = 'en' | 'zh-CN'

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
      cliLogFilePath: '/tmp/tianji-test/config/logs/tianji.log',
      daemonPortPath: '/tmp/tianji-test/config/daemon.port',
      daemonPidPath: '/tmp/tianji-test/config/daemon.pid',
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
    snapshotStore: new FileSnapshotStore('/tmp/tianji-test/runtime-snapshots'),
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

/**
 * 捕获长生命周期任务的 stdout，并暴露实时读取能力。
 *
 * @param fn - 在 stdout 被劫持期间执行的异步任务
 * @returns 实时输出读取与清理方法
 */
export async function captureStdoutLive<T>(fn: () => Promise<T>): Promise<{
  readonly getOutput: () => string
  readonly done: Promise<T>
  readonly restore: () => void
}> {
  const chunks: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)

  const spy = (chunk: unknown): boolean => {
    if (typeof chunk === 'string') {
      chunks.push(chunk)
    }
    return true
  }

  process.stdout.write = spy as typeof process.stdout.write

  let restored = false
  const restore = (): void => {
    if (restored) {
      return
    }

    restored = true
    process.stdout.write = originalWrite
  }

  const done = fn().finally(() => {
    restore()
  })

  return {
    getOutput: () => chunks.join(''),
    done,
    restore,
  }
}

/**
 * 轮询等待 stdout 中出现目标文本，适用于 follow 类测试。
 *
 * @param readOutput - 返回当前累计输出的函数
 * @param expectedText - 期望出现的文本片段
 */
export async function waitForOutput(
  readOutput: () => string,
  expectedText: string,
  timeoutMs = 4_000
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (readOutput().includes(expectedText)) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error(`Timed out waiting for output: ${expectedText}`)
}

/**
 * 创建独立的 CLI 临时配置路径，避免测试之间互相污染。
 *
 * @returns 临时路径集合及清理函数
 */
export async function createTempCliPaths(): Promise<{
  readonly paths: UserConfigPaths
  readonly cleanup: () => Promise<void>
}> {
  const configDir = await mkdtemp(join(tmpdir(), 'tianji-cli-test-'))
  const paths: UserConfigPaths = {
    configDir,
    agentsDir: join(configDir, 'agents'),
    logsDir: join(configDir, 'logs'),
    configFilePath: join(configDir, 'tianji.json'),
    cliLogFilePath: join(configDir, 'logs', 'tianji.log'),
    daemonPortPath: join(configDir, 'daemon.port'),
    daemonPidPath: join(configDir, 'daemon.pid'),
  }

  return {
    paths,
    cleanup: () => rm(configDir, { recursive: true, force: true }),
  }
}

/**
 * 创建带 locale 注入的 CLI 依赖。
 *
 * @param locale - 测试使用的 locale
 * @param overrides - 额外依赖覆盖
 * @returns 带 locale 配置注入的依赖对象
 */
export function createDepsWithLocale(
  locale: CliTestLocale,
  overrides: Partial<CliDependencies> = {}
): CliDependencies {
  const ctx = createFakeContext()

  return {
    getUserConfigPaths: () => ctx.paths,
    loadConfig: async () => ({ locale }) as never,
    ...overrides,
  }
}

/**
 * 创建不显式注入 locale 的 CLI 依赖。
 *
 * @param overrides - 额外依赖覆盖
 * @returns 默认英文回退场景使用的依赖对象
 */
export function createDepsWithoutLocale(overrides: Partial<CliDependencies> = {}): CliDependencies {
  const ctx = createFakeContext()

  return {
    getUserConfigPaths: () => ctx.paths,
    loadConfig: async () => ({}),
    ...overrides,
  }
}

export function createFakeAgentRunner(
  events: readonly RuntimeEvent[],
  onChat?: (prompt: string) => void | Promise<void>
): AgentRunner {
  return {
    agentId: 'default',
    connect: async () => undefined,
    disconnect: async () => undefined,
    async *query(prompt: string): AsyncIterable<RuntimeEvent> {
      await onChat?.(prompt)
      for (const event of events) {
        yield event
      }
    },
  } as AgentRunner
}
