import { writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'

import { chatCommand } from '../commands/chat.js'
import type { CommandContext } from '../commands/types.js'
import { createI18n } from '../i18n/index.js'
import { createTempCliPaths } from './helpers/cli-test-utils.js'

vi.mock('@tianji/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tianji/agent')>()
  return {
    ...original,
    DaemonClient: vi.fn(),
  }
})

import { DaemonClient } from '@tianji/agent'

const MockedDaemonClient = vi.mocked(DaemonClient)

describe('chatCommand', () => {
  it('throws when daemon port file does not exist', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    const i18n = createI18n('en')

    const context: CommandContext = {
      args: {},
      options: {},
      i18n,
      deps: {
        getUserConfigPaths: () => paths,
      },
    }

    await expect(chatCommand.handler(context)).rejects.toThrow()

    await cleanup()
  })

  it('throws when daemon port file contains invalid content', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    const i18n = createI18n('en')

    await writeFile(paths.daemonPortPath, 'not-a-number', 'utf8')

    const context: CommandContext = {
      args: {},
      options: {},
      i18n,
      deps: {
        getUserConfigPaths: () => paths,
      },
    }

    await expect(chatCommand.handler(context)).rejects.toThrow()

    await cleanup()
  })

  it('throws when daemon port file contains zero', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    const i18n = createI18n('en')

    await writeFile(paths.daemonPortPath, '0', 'utf8')

    const context: CommandContext = {
      args: {},
      options: {},
      i18n,
      deps: {
        getUserConfigPaths: () => paths,
      },
    }

    await expect(chatCommand.handler(context)).rejects.toThrow()

    await cleanup()
  })

  it('throws when daemon port file contains negative number', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    const i18n = createI18n('en')

    await writeFile(paths.daemonPortPath, '-1', 'utf8')

    const context: CommandContext = {
      args: {},
      options: {},
      i18n,
      deps: {
        getUserConfigPaths: () => paths,
      },
    }

    await expect(chatCommand.handler(context)).rejects.toThrow()

    await cleanup()
  })

  it('connects to daemon and handles .exit command', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    const i18n = createI18n('en')

    await writeFile(paths.daemonPortPath, '12345', 'utf8')

    const mockPing = vi.fn(async () => ({ pid: 1234 }))

    MockedDaemonClient.mockImplementation(
      () =>
        ({
          ping: mockPing,
          sendChat: vi.fn(),
          shutdown: vi.fn(),
        }) as unknown as InstanceType<typeof DaemonClient>
    )

    const stdoutChunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      if (typeof chunk === 'string') stdoutChunks.push(chunk)
      return true
    }) as typeof process.stdout.write

    // Create a fake readable stream that emits ".exit"
    const { PassThrough } = await import('node:stream')
    const fakeStdin = new PassThrough()

    const originalStdin = process.stdin
    Object.defineProperty(process, 'stdin', { value: fakeStdin, writable: true })

    const context: CommandContext = {
      args: {},
      options: {},
      i18n,
      deps: {
        getUserConfigPaths: () => paths,
      },
    }

    const handlerPromise = chatCommand.handler(context)

    // Give readline time to initialize, then send .exit
    await new Promise((resolve) => setTimeout(resolve, 50))
    fakeStdin.write('.exit\n')
    fakeStdin.end()

    const result = await handlerPromise

    process.stdout.write = originalWrite
    Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true })

    expect(mockPing).toHaveBeenCalled()
    expect(result).toBe(0)
    expect(stdoutChunks.join('')).toContain('1234')

    await cleanup()
  })

  it('sends chat messages and prints delta events', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    const i18n = createI18n('en')

    await writeFile(paths.daemonPortPath, '12345', 'utf8')

    const mockPing = vi.fn(async () => ({ pid: 1234 }))

    async function* fakeSendChat(_prompt: string) {
      yield {
        type: 'MessageDelta' as const,
        channel: 'text' as const,
        payload: { content: 'Hello' },
      }
      yield {
        type: 'MessageDelta' as const,
        channel: 'text' as const,
        payload: { content: ' World' },
      }
    }

    MockedDaemonClient.mockImplementation(
      () =>
        ({
          ping: mockPing,
          sendChat: fakeSendChat,
          shutdown: vi.fn(),
        }) as unknown as InstanceType<typeof DaemonClient>
    )

    const stdoutChunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      if (typeof chunk === 'string') stdoutChunks.push(chunk)
      return true
    }) as typeof process.stdout.write

    const { PassThrough } = await import('node:stream')
    const fakeStdin = new PassThrough()
    const originalStdin = process.stdin
    Object.defineProperty(process, 'stdin', { value: fakeStdin, writable: true })

    const context: CommandContext = {
      args: {},
      options: {},
      i18n,
      deps: {
        getUserConfigPaths: () => paths,
      },
    }

    const handlerPromise = chatCommand.handler(context)

    await new Promise((resolve) => setTimeout(resolve, 50))
    fakeStdin.write('hi there\n')

    await new Promise((resolve) => setTimeout(resolve, 50))
    fakeStdin.write('.exit\n')
    fakeStdin.end()

    const result = await handlerPromise

    process.stdout.write = originalWrite
    Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true })

    const output = stdoutChunks.join('')
    expect(output).toContain('Hello')
    expect(output).toContain(' World')
    expect(result).toBe(0)

    await cleanup()
  })

  it('skips empty lines in the REPL loop', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    const i18n = createI18n('en')

    await writeFile(paths.daemonPortPath, '12345', 'utf8')

    const mockPing = vi.fn(async () => ({ pid: 1234 }))
    const mockSendChat = vi.fn(async function* () {
      yield { type: 'MessageDelta' as const, channel: 'text' as const, payload: { content: 'ok' } }
    })

    MockedDaemonClient.mockImplementation(
      () =>
        ({
          ping: mockPing,
          sendChat: mockSendChat,
          shutdown: vi.fn(),
        }) as unknown as InstanceType<typeof DaemonClient>
    )

    const stdoutChunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      if (typeof chunk === 'string') stdoutChunks.push(chunk)
      return true
    }) as typeof process.stdout.write

    const { PassThrough } = await import('node:stream')
    const fakeStdin = new PassThrough()
    const originalStdin = process.stdin
    Object.defineProperty(process, 'stdin', { value: fakeStdin, writable: true })

    const context: CommandContext = {
      args: {},
      options: {},
      i18n,
      deps: {
        getUserConfigPaths: () => paths,
      },
    }

    const handlerPromise = chatCommand.handler(context)

    await new Promise((resolve) => setTimeout(resolve, 50))
    // Send empty line, then whitespace-only, then a real message, then exit
    fakeStdin.write('\n')
    fakeStdin.write('   \n')
    fakeStdin.write('real message\n')

    await new Promise((resolve) => setTimeout(resolve, 50))
    fakeStdin.write('.exit\n')
    fakeStdin.end()

    await handlerPromise

    process.stdout.write = originalWrite
    Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true })

    // sendChat should only be called once (for "real message"), not for empty lines
    expect(mockSendChat).toHaveBeenCalledTimes(1)
    expect(mockSendChat).toHaveBeenCalledWith('real message')

    await cleanup()
  })
})
