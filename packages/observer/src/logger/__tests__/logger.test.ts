import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createJsonlFileSink,
  createMemorySink,
  createObserverLogger,
  createStdoutSink,
} from '../index.js'

const tmpDirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()

  await Promise.all(
    tmpDirs.splice(0).map(async (dirPath) => {
      await rm(dirPath, { recursive: true, force: true })
    })
  )
})

describe('createObserverLogger', () => {
  it('redacts sensitive keys and normalizes Error values', async () => {
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })

    await logger.info(['cli'], 'loaded', {
      apiKey: 'secret',
      nested: {
        prompt: 'hidden',
        keep: true,
      },
      error: new Error('boom'),
    })

    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0]?.data).toEqual({
      nested: { keep: true },
      error: expect.objectContaining({
        name: 'Error',
        message: 'boom',
        stack: expect.any(String),
      }),
    })
  })

  it('merges child scope and bindings', async () => {
    const sink = createMemorySink()
    const logger = createObserverLogger({
      sinks: [sink],
      scope: ['cli'],
      bindings: { agentName: 'default' },
    })
    const child = logger.child({ scope: ['run'], bindings: { provider: 'openai' } })

    await child.info(['event'], 'received', { eventType: 'message.delta' })

    expect(sink.entries[0]).toMatchObject({
      scope: ['cli', 'run', 'event'],
      data: {
        agentName: 'default',
        provider: 'openai',
        eventType: 'message.delta',
      },
    })
  })

  it('writes CLI-compatible JSONL entries', async () => {
    const dirPath = await mkdtemp(join(tmpdir(), 'observer-logger-'))
    tmpDirs.push(dirPath)

    const filePath = join(dirPath, 'logs', 'observer.jsonl')
    const logger = createObserverLogger({ sinks: [createJsonlFileSink({ filePath })] })

    await logger.info(['cli'], 'loaded', {
      agentName: 'demo-agent',
      provider: 'openai',
    })

    const contents = await readFile(filePath, 'utf8')

    expect(contents).toContain('\n')
    expect(JSON.parse(contents.trim())).toMatchObject({
      level: 'info',
      scope: ['cli'],
      message: 'loaded',
      data: {
        agentName: 'demo-agent',
        provider: 'openai',
      },
    })
  })

  it('collects entries with memory sink', async () => {
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })

    await logger.warn(['cli'], 'buffering', { pending: 2 })

    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0]).toMatchObject({
      level: 'warn',
      scope: ['cli'],
      message: 'buffering',
      data: { pending: 2 },
    })
  })

  it('writes structured JSON to stdout by default', async () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })

    const logger = createObserverLogger({ sinks: [createStdoutSink()] })

    await logger.info(['cli'], 'loaded', { provider: 'openai' })

    expect(writes).toHaveLength(1)
    const jsonLine = writes[0]

    expect(jsonLine).toBeDefined()
    expect(() => JSON.parse(String(jsonLine).trim())).not.toThrow()
    expect(JSON.parse(String(jsonLine).trim())).toMatchObject({
      level: 'info',
      scope: ['cli'],
      message: 'loaded',
      data: { provider: 'openai' },
    })
  })

  it('writes pretty stdout lines when enabled', async () => {
    const writes: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })

    const logger = createObserverLogger({ sinks: [createStdoutSink({ pretty: true })] })

    await logger.error(['cli'], 'failed', { provider: 'openai' })

    expect(writes).toHaveLength(1)
    const prettyLine = writes[0]

    expect(prettyLine).toBeDefined()
    expect(String(prettyLine)).toMatch(/^\[error\] cli failed \{"provider":"openai"\}\n$/)
  })
})
