/**
 * CLI run 命令端到端测试。
 *
 * 使用 FakeListChatModel 替代真实 LLM，通过依赖注入验证完整的
 * 配置加载 -> runtime 创建 -> session/run -> 事件流消费 -> stdout 输出链路。
 */
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { ProviderError, type RuntimeEvent } from '@tianji/contracts'
import { createSessionRuntime } from '@tianji/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCliRuntime, runCli } from '../main.js'
import { captureStdout, createFakeContext } from './helpers/cli-test-utils.js'

const KNOWN_ENV_KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY']

afterEach(() => {
  for (const key of KNOWN_ENV_KEYS) {
    delete process.env[key]
  }
  vi.restoreAllMocks()
})

async function* failedRunEvents(): AsyncGenerator<RuntimeEvent> {
  yield {
    type: 'run.failed' as const,
    runId: 'run_test' as import('@tianji/contracts').RunId,
    sessionId: 'session_test' as import('@tianji/contracts').SessionId,
    error: new ProviderError('TEST_FAILURE', 'Test simulated failure'),
    timestamp: Date.now(),
  }
}

describe('CLI run command e2e', () => {
  it('streams assistant text to stdout and returns exit code 0', async () => {
    const fakeModel = new FakeListChatModel({
      responses: ['hello from fake model'],
    })
    const fakeRuntime = createSessionRuntime({
      deepagents: { model: fakeModel },
    })
    const fakeContext = createFakeContext()

    const output = await captureStdout(async () => {
      const exitCode = await runCli(['run', 'say hello'], {
        loadContext: () => Promise.resolve(fakeContext),
        createRuntime: () => fakeRuntime,
      })

      expect(exitCode).toBe(0)
    })

    expect(output).toContain('hello from fake model')
    expect(output).toContain('\n')
  })

  it('passes SOUL.md content as systemPrompt to runTurn', async () => {
    const fakeModel = new FakeListChatModel({
      responses: ['acknowledged'],
    })

    let capturedSystemPrompt: string | undefined
    const fakeRuntime = createSessionRuntime({
      deepagents: { model: fakeModel },
    })

    const originalRunTurn = fakeRuntime.runTurn.bind(fakeRuntime)
    vi.spyOn(fakeRuntime, 'runTurn').mockImplementation(async (options) => {
      capturedSystemPrompt = options.systemPrompt
      return originalRunTurn(options)
    })

    const fakeContext = createFakeContext({
      agent: {
        ...createFakeContext().agent,
        soul: '# Custom Soul\n\nYou are a custom test agent.\n',
      },
    })

    await captureStdout(async () => {
      const exitCode = await runCli(['run', 'test'], {
        loadContext: () => Promise.resolve(fakeContext),
        createRuntime: () => fakeRuntime,
      })
      expect(exitCode).toBe(0)
    })

    expect(capturedSystemPrompt).toBe('# Custom Soul\n\nYou are a custom test agent.\n')
  })

  it('returns exit code 1 on runtime failure', async () => {
    const fakeModel = new FakeListChatModel({
      responses: ['will not be used'],
    })

    const fakeRuntime = createSessionRuntime({
      deepagents: { model: fakeModel },
    })

    vi.spyOn(fakeRuntime, 'streamEvents').mockReturnValue(failedRunEvents())

    const fakeContext = createFakeContext()
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const exitCode = await runCli(['run', 'test'], {
      loadContext: () => Promise.resolve(fakeContext),
      createRuntime: () => fakeRuntime,
    })

    expect(exitCode).toBe(1)
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Run failed'))
  })

  it('passes configured openai baseUrl into the runtime model', async () => {
    const fakeContext = createFakeContext({
      agent: {
        ...createFakeContext().agent,
        provider: 'openai',
        modelName: 'gpt-latest-medium',
        providerConfig: {
          apiKey: 'test-key',
          baseUrl: 'http://example.test/v1',
        },
      },
    })

    const runtime = createCliRuntime(fakeContext)
    const runtimeRecord = runtime as unknown as {
      options?: {
        deepagents?: {
          model?: {
            lc_kwargs?: {
              configuration?: {
                baseURL?: string
              }
            }
          }
        }
      }
    }

    expect(runtimeRecord.options?.deepagents?.model?.lc_kwargs?.configuration?.baseURL).toBe(
      'http://example.test/v1'
    )
  })

  it('returns exit code 2 for missing command', async () => {
    const exitCode = await runCli([])
    expect(exitCode).toBe(2)
  })

  it('returns exit code 2 for unknown command', async () => {
    const exitCode = await runCli(['bad'])
    expect(exitCode).toBe(2)
  })

  it('returns exit code 2 for run without prompt', async () => {
    const exitCode = await runCli(['run'])
    expect(exitCode).toBe(2)
  })
})
