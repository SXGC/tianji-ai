/**
 * CLI 集成测试。
 *
 * 使用依赖注入与临时文件验证 `runCli()` 的主命令分发、run 编排和 log follow
 * 行为，避免依赖真实子进程和外部 LLM 服务。
 */
import { mkdir, readFile, truncate, writeFile } from 'node:fs/promises'

import { FakeListChatModel } from '@langchain/core/utils/testing'
import { createAgentRuntime } from '@tianji/agent'
import { createSessionRuntime } from '@tianji/runtime'
import { ProviderError, type RunId, type RuntimeEvent, type SessionId } from '@tianji/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createI18n } from '../i18n/index.js'
import { followCliLog } from '../log-follow.js'
import { parseCliArgs, runCli } from '../main.js'
import {
  captureStdout,
  captureStdoutLive,
  createFakeAgentRunner,
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
    runId: 'run_test' as RunId,
    sessionId: 'session_test' as SessionId,
    triggerType: 'new',
    error: new ProviderError('TEST_FAILURE', 'Test simulated failure'),
    timestamp: Date.now(),
  }
}

describe('CLI integration', () => {
  describe('run command', () => {
    it('streams assistant text to stdout and returns exit code 0', async () => {
      const fakeContext = createFakeContext()
      const runner = createFakeAgentRunner([
        {
          type: 'message.delta',
          runId: 'run_test' as RunId,
          messageId: 'msg_1',
          sequence: 1,
          channel: 'text',
          payload: { content: 'hello from fake model' },
          timestamp: Date.now(),
        },
        {
          type: 'run.completed',
          runId: 'run_test' as RunId,
          sessionId: 'session_test' as SessionId,
          triggerType: 'new',
          timestamp: Date.now(),
        },
      ])

      const output = await captureStdout(async () => {
        const exitCode = await runCli(['run', 'say hello'], {
          loadContext: () => Promise.resolve(fakeContext),
          createAgentRunner: () => runner,
          getUserConfigPaths: () => fakeContext.paths,
        })

        expect(exitCode).toBe(0)
      })

      expect(output).toContain('hello from fake model')
      expect(output).toContain('\n')
    })

    it('passes SOUL.md content as systemPrompt to runTurn', async () => {
      let capturedPrompt: string | undefined

      const fakeContext = createFakeContext({
        agent: {
          ...createFakeContext().agent,
          soul: '# Custom Soul\n\nYou are a custom test agent.\n',
        },
      })

      const runner = createFakeAgentRunner(
        [
          {
            type: 'run.completed',
            runId: 'run_test' as RunId,
            sessionId: 'session_test' as SessionId,
            triggerType: 'new',
            timestamp: Date.now(),
          },
        ],
        (prompt) => {
          capturedPrompt = prompt
        }
      )

      await captureStdout(async () => {
        const exitCode = await runCli(['run', 'test'], {
          loadContext: () => Promise.resolve(fakeContext),
          createAgentRunner: () => runner,
          getUserConfigPaths: () => fakeContext.paths,
        })
        expect(exitCode).toBe(0)
      })

      expect(capturedPrompt).toBe('test')
    })

    it('returns exit code 1 on runtime failure', async () => {
      const fakeContext = createFakeContext()
      const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const runner = createFakeAgentRunner([
        {
          type: 'run.failed',
          runId: 'run_test' as RunId,
          sessionId: 'session_test' as SessionId,
          triggerType: 'new',
          error: new ProviderError('TEST_FAILURE', 'Test simulated failure'),
          timestamp: Date.now(),
        },
      ])

      const exitCode = await runCli(['run', 'test'], {
        loadContext: () => Promise.resolve(fakeContext),
        createAgentRunner: () => runner,
        getUserConfigPaths: () => fakeContext.paths,
      })

      expect(exitCode).toBe(1)
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Run failed'))
    })

    it('writes observer JSONL entries compatible with log follow output', async () => {
      const fakeContext = createFakeContext()
      const runner = createFakeAgentRunner([
        {
          type: 'message.delta',
          runId: 'run_test' as RunId,
          messageId: 'msg_1',
          sequence: 1,
          channel: 'text',
          payload: { content: 'observer delta text' },
          timestamp: Date.now(),
        },
        {
          type: 'run.completed',
          runId: 'run_test' as RunId,
          sessionId: 'session_test' as SessionId,
          triggerType: 'new',
          timestamp: Date.now(),
        },
      ])

      await captureStdout(async () => {
        const exitCode = await runCli(['run', 'test observer logger'], {
          loadContext: () => Promise.resolve(fakeContext),
          createAgentRunner: () => runner,
          getUserConfigPaths: () => fakeContext.paths,
        })

        expect(exitCode).toBe(0)
      })

      const captured = await captureStdout(async () => {
        await followCliLog(fakeContext.paths.cliLogFilePath, createI18n('en'), {
          signal: AbortSignal.timeout(5),
        })
      })

      expect(captured).toContain('Received run command {"promptLength":20}')
      expect(captured).toContain('Loaded user config context')
      expect(captured).toContain(
        'Received runtime event {"eventType":"message.delta","runId":"run_test","messageId":"msg_1","sequence":1,"channel":"text","delta":"observer delta text","deltaLength":19}'
      )
      expect(captured).toContain(
        'Run command completed {"runId":"run_test","sessionId":"session_test"}'
      )

      const logFileContent = await readFile(fakeContext.paths.cliLogFilePath, 'utf8')
      expect(logFileContent).not.toContain('test observer logger')
      expect(logFileContent).not.toContain(fakeContext.agent.soul)
    })

    it('maps agent runtime model to configured model instance', async () => {
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

      const runtime = createAgentRuntime(fakeContext)
      const runtimeRecord = runtime as unknown as {
        options?: {
          deepagents?: {
            model?: {
              model?: string
            }
          }
        }
      }

      expect(runtimeRecord.options?.deepagents?.model?.model).toBe('gpt-latest-medium')
    })

    it('passes provider baseUrl through agent runtime config', async () => {
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

      const runtime = createAgentRuntime(fakeContext)
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
    it('treats log without explicit follow flag as follow by default', async () => {
      const followSpy = vi.fn(async () => undefined)

      await runCli(['log'], {
        followCliLog: followSpy,
        getUserConfigPaths: () => createFakeContext().paths,
      })

      expect(followSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ lines: 100 })
      )
    })

    it('passes follow=true when log is invoked without explicit flag', async () => {
      const followSpy = vi.fn(async () => undefined)

      await runCli(['log'], {
        followCliLog: followSpy,
        getUserConfigPaths: () => createFakeContext().paths,
      })

      expect(followSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ locale: 'en', t: expect.any(Function) }),
        expect.objectContaining({ lines: 100, follow: true })
      )
    })

    it('replays only the configured number of latest lines before following', async () => {
      const { paths, cleanup } = await createTempCliPaths()
      const abortController = new AbortController()

      try {
        await mkdir(paths.logsDir, { recursive: true })
        await writeFile(
          paths.cliLogFilePath,
          [
            {
              timestamp: '2026-03-25T10:00:00.000Z',
              level: 'info',
              scope: ['cli', 'run'],
              message: 'entry-1',
            },
            {
              timestamp: '2026-03-25T10:00:01.000Z',
              level: 'info',
              scope: ['cli', 'run'],
              message: 'entry-2',
            },
            {
              timestamp: '2026-03-25T10:00:02.000Z',
              level: 'info',
              scope: ['cli', 'run'],
              message: 'entry-3',
            },
          ]
            .map((entry) => JSON.stringify(entry))
            .join('\n')
            .concat('\n'),
          'utf8'
        )

        const captured = await captureStdoutLive(async () => {
          return runCli(['log', '--lines', '2'], {
            getUserConfigPaths: () => paths,
            followCliLog: (logFilePath, i18n, options) =>
              followCliLog(logFilePath, i18n, {
                ...options,
                signal: abortController.signal,
              }),
          })
        })

        await waitForOutput(captured.getOutput, 'entry-2')
        await waitForOutput(captured.getOutput, 'entry-3')
        expect(captured.getOutput()).not.toContain('entry-1')

        abortController.abort()
        await expect(captured.done).resolves.toBe(0)
      } finally {
        await cleanup()
      }
    })

    it('prints waiting message, existing history, appended entries, and invalid lines', async () => {
      const { paths, cleanup } = await createTempCliPaths()
      const abortController = new AbortController()

      try {
        const captured = await captureStdoutLive(async () => {
          return runCli(['log'], {
            getUserConfigPaths: () => paths,
            followCliLog: (logFilePath, i18n) =>
              followCliLog(logFilePath, i18n, {
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
          return runCli(['log'], {
            getUserConfigPaths: () => paths,
            followCliLog: (logFilePath, i18n) =>
              followCliLog(logFilePath, i18n, {
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
    it('prints available commands and descriptions for help', async () => {
      const output = await captureStdout(async () => {
        const exitCode = await runCli(['help'])
        expect(exitCode).toBe(0)
      })

      expect(output).toContain('Usage:')
      expect(output).toContain('tianji v0.0.1')
      expect(output).toContain('tianji run <prompt>')
      expect(output).toContain('Run one prompt through the configured agent')
      expect(output).toContain('tianji log')
      expect(output).toContain('Follow the CLI log and replay the latest lines first')
      expect(output).toContain('-h, --help')
      expect(output).toContain('-V, --version')
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

    it('returns exit code 2 for log with unsupported flag', async () => {
      const exitCode = await runCli(['log', '--tail'])
      expect(exitCode).toBe(2)
    })

    it('parses log follow lines options with defaults and aliases', () => {
      expect(parseCliArgs(['log'])).toEqual({
        kind: 'log-follow',
        lines: 100,
      })
      expect(parseCliArgs(['log', '--follow', '--lines', '25'])).toEqual({
        kind: 'log-follow',
        lines: 25,
      })
      expect(parseCliArgs(['log', '-f', '-n', '12'])).toEqual({
        kind: 'log-follow',
        lines: 12,
      })
    })

    it('returns exit code 2 for invalid lines values', async () => {
      expect(() => parseCliArgs(['log', '-f', '--lines', '0'])).toThrowError(/valid number/)
      expect(() => parseCliArgs(['log', '-f', '--lines', 'abc'])).toThrowError(/valid number/)

      const exitCode = await runCli(['log', '-f', '--lines', '0'])
      expect(exitCode).toBe(2)
    })
  })
})
