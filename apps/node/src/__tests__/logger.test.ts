import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ObserverLogEntry } from '@tianji/observer'

import type { UserConfigPaths } from '../config.js'
import {
  appendCliLog,
  createCliLogger,
  getCliLogger,
  logDebug,
  logError,
  logInfo,
  logWarn,
} from '../logger.js'

import { createTempCliPaths } from './helpers/cli-test-utils.js'

describe('createCliLogger', () => {
  it('appendCliLog delegates to the provided sink', async () => {
    const written: ObserverLogEntry[] = []
    const sink = {
      write: vi.fn(async (entry: ObserverLogEntry) => {
        written.push(entry)
      }),
    }
    const logger = createCliLogger({ sink })

    const entry: ObserverLogEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      scope: ['test'],
      message: 'hello',
    }

    await logger.appendCliLog(entry)

    expect(sink.write).toHaveBeenCalledWith(entry)
    expect(written).toHaveLength(1)
  })

  it('logDebug forwards to observer debug', async () => {
    const written: ObserverLogEntry[] = []
    const sink = {
      write: vi.fn(async (entry: ObserverLogEntry) => {
        written.push(entry)
      }),
    }
    const logger = createCliLogger({ sink })

    await logger.logDebug(['cli'], 'debug message', { key: 'val' })

    expect(written).toHaveLength(1)
    expect(written[0]!.level).toBe('debug')
    expect(written[0]!.message).toBe('debug message')
  })

  it('logInfo forwards to observer info', async () => {
    const written: ObserverLogEntry[] = []
    const sink = {
      write: vi.fn(async (entry: ObserverLogEntry) => {
        written.push(entry)
      }),
    }
    const logger = createCliLogger({ sink })

    await logger.logInfo(['cli'], 'info message')

    expect(written).toHaveLength(1)
    expect(written[0]!.level).toBe('info')
  })

  it('logWarn forwards to observer warn', async () => {
    const written: ObserverLogEntry[] = []
    const sink = {
      write: vi.fn(async (entry: ObserverLogEntry) => {
        written.push(entry)
      }),
    }
    const logger = createCliLogger({ sink })

    await logger.logWarn(['cli'], 'warn message')

    expect(written).toHaveLength(1)
    expect(written[0]!.level).toBe('warn')
  })

  it('logError forwards to observer error', async () => {
    const written: ObserverLogEntry[] = []
    const sink = {
      write: vi.fn(async (entry: ObserverLogEntry) => {
        written.push(entry)
      }),
    }
    const logger = createCliLogger({ sink })

    await logger.logError(['cli'], 'error message', { code: 42 })

    expect(written).toHaveLength(1)
    expect(written[0]!.level).toBe('error')
  })
})

describe('path-based log helpers', () => {
  let paths: Awaited<ReturnType<typeof createTempCliPaths>>['paths']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempCliPaths()
    paths = tmp.paths
    cleanup = tmp.cleanup
  })

  it('appendCliLog writes JSONL to the log file', async () => {
    const entry: ObserverLogEntry = {
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'info',
      scope: ['test'],
      message: 'path-based append',
    }

    await appendCliLog(paths, entry)

    const content = await readFile(paths.cliLogFilePath, 'utf8')
    const parsed = JSON.parse(content.trim()) as ObserverLogEntry
    expect(parsed.message).toBe('path-based append')
    expect(parsed.level).toBe('info')

    await cleanup()
  })

  it('logInfo writes info entry to log file', async () => {
    await logInfo(paths, ['cli'], 'info via path')

    const content = await readFile(paths.cliLogFilePath, 'utf8')
    expect(content).toContain('"info"')
    expect(content).toContain('info via path')

    await cleanup()
  })

  it('logDebug writes debug entry to log file', async () => {
    await logDebug(paths, ['cli'], 'debug via path')

    const content = await readFile(paths.cliLogFilePath, 'utf8')
    expect(content).toContain('"debug"')
    expect(content).toContain('debug via path')

    await cleanup()
  })

  it('logError writes error entry to log file', async () => {
    await logError(paths, ['cli'], 'error via path', { code: 500 })

    const content = await readFile(paths.cliLogFilePath, 'utf8')
    expect(content).toContain('"error"')
    expect(content).toContain('error via path')

    await cleanup()
  })

  it('logWarn writes warn entry to log file', async () => {
    await logWarn(paths, ['cli'], 'warn via path')

    const content = await readFile(paths.cliLogFilePath, 'utf8')
    expect(content).toContain('"warn"')
    expect(content).toContain('warn via path')

    await cleanup()
  })

  it('creates the logs directory if it does not exist', async () => {
    // The temp dir is fresh, so logsDir does not exist yet.
    // Writing should create it automatically.
    await logInfo(paths, ['cli'], 'auto-mkdir test')

    const content = await readFile(paths.cliLogFilePath, 'utf8')
    expect(content).toContain('auto-mkdir test')

    await cleanup()
  })
})

describe('getCliLogger sinks', () => {
  let tmpRoot: string
  let paths: UserConfigPaths
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'tianji-cli-log-'))
    paths = {
      logsDir: join(tmpRoot, 'logs'),
      cliLogFilePath: join(tmpRoot, 'logs', 'cli.jsonl'),
    } as UserConfigPaths
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    stderrSpy.mockRestore()
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('writes jsonl file for all levels and stderr only for warn/error', async () => {
    const cli = getCliLogger(paths)
    await cli.logDebug(['cli', 'test'], 'debug-msg')
    await cli.logWarn(['cli', 'test'], 'warn-msg')
    await cli.logError(['cli', 'test'], 'error-msg', { detail: 'boom' })

    const fileContent = await readFile(paths.cliLogFilePath, 'utf8')
    const lines = fileContent
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.level)).toEqual(['debug', 'warn', 'error'])

    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('')
    expect(stderrOutput).not.toContain('debug-msg')
    expect(stderrOutput).toContain('warn-msg')
    expect(stderrOutput).toContain('error-msg')
  })
})
