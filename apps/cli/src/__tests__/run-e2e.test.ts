/**
 * CLI 集成测试。
 *
 * 使用依赖注入与临时文件验证 `runCli()` 的主命令分发、run 编排和 log follow
 * 行为，避免依赖真实子进程和外部 LLM 服务。
 */
import { mkdir, truncate, writeFile } from 'node:fs/promises'

import { FakeListChatModel } from '@langchain/core/utils/testing'
import { ProviderError, type RuntimeEvent } from '@tianji/contracts'
import { createSessionRuntime } from '@tianji/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { followCliLog } from '../log-follow.js'
import { createCliRuntime, runCli } from '../main.js'
import {
  captureStdout,
  captureStdoutLive,
  createFakeContext,
  createTempCliPaths,
  waitForOutput,
} from './helpers/cli-test-utils.js'

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

describe('CLI integration', () => {
  describe('run command', () => {
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
          getUserConfigPaths: () => fakeContext.paths,
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
          getUserConfigPaths: () => fakeContext.paths,
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
        getUserConfigPaths: () => fakeContext.paths,
      })

      expect(exitCode).toBe(1)
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Run failed'))
    })

    it('maps runtime model to provider:modelName string', async () => {
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
            model?: string
          }
        }
      }

      expect(runtimeRecord.options?.deepagents?.model).toBe('openai:gpt-latest-medium')
    })

    it('passes provider baseUrl through runtime config', async () => {
      const fakeContext = createFakeContext({
        agent: {
          ...createFakeContext().agent,
          provider: 'openai',
          modelName: 'gpt-latest-medium',
          providerConfig: {
            apiKey: 'test-key',
            baseUrl: 'http://example.test/v1',
            headers: {
              'x-test-header': 'enabled',
            },
          },
        },
      })

      const runtime = createCliRuntime(fakeContext)
      const runtimeRecord = runtime as unknown as {
        options?: {
          deepagents?: {
            providerConfig?: {
              provider?: string
              model?: string
              baseUrl?: string
              headers?: Record<string, string>
            }
          }
        }
      }

      expect(runtimeRecord.options?.deepagents?.providerConfig).toEqual({
        provider: 'openai',
        model: 'gpt-latest-medium',
        apiKey: 'test-key',
        baseUrl: 'http://example.test/v1',
        headers: {
          'x-test-header': 'enabled',
        },
      })
    })
  })

  describe('log command', () => {
    it('prints waiting message, existing history, appended entries, and invalid lines', async () => {
      const { paths, cleanup } = await createTempCliPaths()
      const abortController = new AbortController()

      try {
        const captured = await captureStdoutLive(async () => {
          return runCli(['log', '-f'], {
            getUserConfigPaths: () => paths,
            followCliLog: (logFilePath) =>
              followCliLog(logFilePath, {
                signal: abortController.signal,
              }),
          })
        })

        await waitForOutput(captured.getOutput, `Waiting for CLI log file: ${paths.cliLogFilePath}`)

        await mkdir(paths.logsDir, { recursive: true })
        await writeFile(
          paths.cliLogFilePath,
          `${JSON.stringify({
            timestamp: '2026-03-25T10:00:00.000Z',
            level: 'info',
            scope: ['cli', 'run', 'config'],
            message: 'Loaded user config',
            data: { agentName: 'default' },
          })}\n`,
          'utf8'
        )

        await waitForOutput(captured.getOutput, `Detected CLI log file: ${paths.cliLogFilePath}`)
        await waitForOutput(captured.getOutput, 'Loaded user config {"agentName":"default"}')

        await writeFile(
          paths.cliLogFilePath,
          `${JSON.stringify({
            timestamp: '2026-03-25T10:00:01.000Z',
            level: 'info',
            scope: ['cli', 'run'],
            message: 'Run command completed',
          })}\nnot-json\n`,
          { encoding: 'utf8', flag: 'a' }
        )

        await waitForOutput(captured.getOutput, 'Run command completed')
        await waitForOutput(captured.getOutput, '[invalid-cli-log] not-json')

        abortController.abort()
        await expect(captured.done).resolves.toBe(0)
      } finally {
        await cleanup()
      }
    })

    it('restarts from the beginning after log truncation', async () => {
      const { paths, cleanup } = await createTempCliPaths()
      const abortController = new AbortController()

      try {
        await mkdir(paths.logsDir, { recursive: true })
        await writeFile(
          paths.cliLogFilePath,
          `${JSON.stringify({
            timestamp: '2026-03-25T10:00:00.000Z',
            level: 'info',
            scope: ['cli', 'run'],
            message: 'Initial entry',
          })}\n`,
          'utf8'
        )

        const captured = await captureStdoutLive(async () => {
          return runCli(['log', '-f'], {
            getUserConfigPaths: () => paths,
            followCliLog: (logFilePath) =>
              followCliLog(logFilePath, {
                signal: abortController.signal,
              }),
          })
        })

        await waitForOutput(captured.getOutput, 'Initial entry')

        await truncate(paths.cliLogFilePath, 0)
        await writeFile(
          paths.cliLogFilePath,
          `${JSON.stringify({
            timestamp: '2026-03-25T10:00:02.000Z',
            level: 'warn',
            scope: ['cli', 'log', 'follow'],
            message: 'After truncate',
          })}\n`,
          'utf8'
        )

        await waitForOutput(
          captured.getOutput,
          'CLI log file was truncated or recreated. Restarting from beginning.'
        )
        await waitForOutput(captured.getOutput, 'After truncate')

        abortController.abort()
        await expect(captured.done).resolves.toBe(0)
      } finally {
        await cleanup()
      }
    })
  })

  describe('usage errors', () => {
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

    it('returns exit code 2 for log without follow flag', async () => {
      const exitCode = await runCli(['log'])
      expect(exitCode).toBe(2)
    })

    it('returns exit code 2 for log with unsupported flag', async () => {
      const exitCode = await runCli(['log', '--tail'])
      expect(exitCode).toBe(2)
    })
  })
})
