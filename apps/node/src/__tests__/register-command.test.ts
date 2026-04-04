import { describe, expect, it, vi } from 'vitest'

import { parseRegisterUrl } from '../commands/register.js'
import { runCli } from '../main.js'
import { captureStdoutLive } from './helpers/cli-test-utils.js'

async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  assertion()
}

describe('parseRegisterUrl', () => {
  it('extracts baseUrl and enrollment token', () => {
    expect(parseRegisterUrl('http://127.0.0.1:3000/register?enrollment-token=test-token')).toEqual({
      baseUrl: 'http://127.0.0.1:3000',
      enrollmentToken: 'test-token',
    })
  })

  it('rejects urls without enrollment token', () => {
    expect(() => parseRegisterUrl('http://127.0.0.1:3000/register')).toThrow(/enrollment-token/)
  })
})

describe('register command', () => {
  it('starts controlplane runtime from register url', async () => {
    const start = vi.fn(async () => undefined)
    const stop = vi.fn(() => undefined)

    const captured = await captureStdoutLive(async () =>
      runCli(['register', 'http://127.0.0.1:3000/register?enrollment-token=test'], {
        loadConfig: async () => ({}),
        createControlPlaneRuntime: (config) => {
          expect(config.baseUrl).toBe('http://127.0.0.1:3000')
          expect(config.enrollmentToken).toBe('test')

          return {
            connection: {
              start,
              stop,
              setExecutionState: vi.fn(),
            },
            taskExecutor: {
              executionState: 'idle',
              currentTaskId: null,
              execute: vi.fn(async () => undefined),
            },
            onCommand: vi.fn(async () => undefined),
          }
        },
      })
    )

    await waitFor(() => {
      expect(start).toHaveBeenCalledOnce()
      expect(captured.getOutput()).toContain('Registering node')
      expect(captured.getOutput()).toContain('nodeId=')
      expect(captured.getOutput()).toContain('baseUrl=http://127.0.0.1:3000')
      expect(captured.getOutput()).toContain('status=connected')
    })

    process.emit('SIGINT')
    expect(stop).toHaveBeenCalled()

    captured.restore()
    void captured.done
  })
})
