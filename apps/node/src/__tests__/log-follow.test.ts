import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createI18n } from '../i18n/index.js'
import {
  formatCliLogEntry,
  parseCliLogLine,
  readCliLogTail,
  replayLatestCliLogLines,
} from '../log-follow.js'

import { captureStdout, createTempCliPaths } from './helpers/cli-test-utils.js'

function makeJsonlLine(index: number, level = 'info'): string {
  return JSON.stringify({
    timestamp: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    level,
    scope: ['test'],
    message: `line ${index}`,
  })
}

function makeJsonlContent(lineCount: number): string {
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    lines.push(makeJsonlLine(i))
  }
  return `${lines.join('\n')}\n`
}

describe('parseCliLogLine', () => {
  it('parses a valid JSONL log entry', () => {
    const entry = parseCliLogLine(
      '{"timestamp":"2026-01-01T00:00:00.000Z","level":"info","scope":["cli"],"message":"hello"}'
    )
    expect(entry).toEqual({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'info',
      scope: ['cli'],
      message: 'hello',
    })
  })

  it('returns null for empty lines', () => {
    expect(parseCliLogLine('')).toBeNull()
    expect(parseCliLogLine('  ')).toBeNull()
  })

  it('returns null for non-JSON text', () => {
    expect(parseCliLogLine('not json at all')).toBeNull()
  })

  it('returns null when level is invalid', () => {
    const line = JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'verbose',
      scope: ['cli'],
      message: 'hello',
    })
    expect(parseCliLogLine(line)).toBeNull()
  })

  it('returns null when scope is not an array', () => {
    const line = JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'info',
      scope: 'cli',
      message: 'hello',
    })
    expect(parseCliLogLine(line)).toBeNull()
  })

  it('parses entry with data field', () => {
    const line = JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'warn',
      scope: ['cli', 'run'],
      message: 'something happened',
      data: { key: 'value' },
    })
    const entry = parseCliLogLine(line)
    expect(entry?.data).toEqual({ key: 'value' })
  })
})

describe('formatCliLogEntry', () => {
  it('formats entry without data', () => {
    const result = formatCliLogEntry({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'info',
      scope: ['cli', 'run'],
      message: 'hello',
    })
    expect(result).toMatch(/^2026-01-01 08:00:00 INFO {2}cli > run {15,}hello$/)
  })

  it('formats entry with data', () => {
    const result = formatCliLogEntry({
      timestamp: '2026-01-01T00:00:00.000Z',
      level: 'error',
      scope: ['test'],
      message: 'fail',
      data: { code: 500 },
    })
    expect(result).toContain('ERROR')
    expect(result).toContain('fail')
    expect(result).toContain('"code":500')
  })

  it('applies ANSI color for error level when colorize is true', () => {
    const result = formatCliLogEntry(
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        level: 'error',
        scope: ['test'],
        message: 'fail',
      },
      true
    )
    expect(result).toContain('\x1b[31m')
    expect(result).toContain('\x1b[0m')
    expect(result).toContain('ERROR')
  })

  it('applies ANSI color for warn level when colorize is true', () => {
    const result = formatCliLogEntry(
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        level: 'warn',
        scope: ['test'],
        message: 'careful',
      },
      true
    )
    expect(result).toContain('\x1b[33m')
  })

  it('applies ANSI color for debug level when colorize is true', () => {
    const result = formatCliLogEntry(
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        level: 'debug',
        scope: ['test'],
        message: 'trace',
      },
      true
    )
    expect(result).toContain('\x1b[90m')
  })

  it('applies ANSI color for info level when colorize is true', () => {
    const result = formatCliLogEntry(
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        level: 'info',
        scope: ['test'],
        message: 'hello',
      },
      true
    )
    expect(result).toContain('\x1b[32m')
  })

  it('does not apply ANSI color when colorize is false', () => {
    const result = formatCliLogEntry(
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        level: 'error',
        scope: ['test'],
        message: 'fail',
      },
      false
    )
    expect(result).not.toContain('\x1b[')
  })
})

describe('readCliLogTail', () => {
  let paths: Awaited<ReturnType<typeof createTempCliPaths>>['paths']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempCliPaths()
    paths = tmp.paths
    cleanup = tmp.cleanup
    await mkdir(paths.logsDir, { recursive: true })
  })

  afterEach(async () => {
    await cleanup()
  })

  it('returns empty string for empty file', async () => {
    await writeFile(paths.cliLogFilePath, '')
    const { stat } = await import('node:fs/promises')
    const fileStat = await stat(paths.cliLogFilePath)
    const result = await readCliLogTail(paths.cliLogFilePath, fileStat.size, 10)
    expect(result).toBe('')
  })

  it('returns empty string when lineCount is zero', async () => {
    await writeFile(paths.cliLogFilePath, makeJsonlContent(5))
    const { stat } = await import('node:fs/promises')
    const fileStat = await stat(paths.cliLogFilePath)
    const result = await readCliLogTail(paths.cliLogFilePath, fileStat.size, 0)
    expect(result).toBe('')
  })

  it('reads only the last N lines from file', async () => {
    const totalLines = 200
    await writeFile(paths.cliLogFilePath, makeJsonlContent(totalLines))
    const { stat } = await import('node:fs/promises')
    const fileStat = await stat(paths.cliLogFilePath)

    const result = await readCliLogTail(paths.cliLogFilePath, fileStat.size, 5)
    const resultLines = result.split('\n').filter((l) => l.trim().length > 0)

    expect(resultLines).toHaveLength(5)
    expect(resultLines[0]).toContain('line 195')
    expect(resultLines[4]).toContain('line 199')
  })

  it('returns all lines when lineCount exceeds total', async () => {
    await writeFile(paths.cliLogFilePath, makeJsonlContent(3))
    const { stat } = await import('node:fs/promises')
    const fileStat = await stat(paths.cliLogFilePath)

    const result = await readCliLogTail(paths.cliLogFilePath, fileStat.size, 100)
    const resultLines = result.split('\n').filter((l) => l.trim().length > 0)

    expect(resultLines).toHaveLength(3)
  })

  it('handles file without trailing newline', async () => {
    const lines: string[] = []
    for (let i = 0; i < 5; i++) {
      lines.push(makeJsonlLine(i))
    }
    await writeFile(paths.cliLogFilePath, lines.join('\n'))
    const { stat } = await import('node:fs/promises')
    const fileStat = await stat(paths.cliLogFilePath)

    const result = await readCliLogTail(paths.cliLogFilePath, fileStat.size, 3)
    const resultLines = result.split('\n').filter((l) => l.trim().length > 0)

    expect(resultLines).toHaveLength(3)
    expect(resultLines[0]).toContain('line 2')
    expect(resultLines[2]).toContain('line 4')
  })
})

describe('replayLatestCliLogLines', () => {
  let paths: Awaited<ReturnType<typeof createTempCliPaths>>['paths']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await createTempCliPaths()
    paths = tmp.paths
    cleanup = tmp.cleanup
    await mkdir(paths.logsDir, { recursive: true })
  })

  afterEach(async () => {
    await cleanup()
  })

  it('outputs only the last N lines', async () => {
    await writeFile(paths.cliLogFilePath, makeJsonlContent(10))
    const { stat } = await import('node:fs/promises')
    const fileStat = await stat(paths.cliLogFilePath)
    const i18n = createI18n('en')

    const output = await captureStdout(async () => {
      await replayLatestCliLogLines(paths.cliLogFilePath, fileStat.size, 3, i18n)
    })

    const outputLines = output.trim().split('\n')
    expect(outputLines).toHaveLength(3)
    expect(outputLines[0]).toContain('line 7')
    expect(outputLines[2]).toContain('line 9')
  })

  it('returns without error when file is empty', async () => {
    await writeFile(paths.cliLogFilePath, '')
    const { stat } = await import('node:fs/promises')
    const fileStat = await stat(paths.cliLogFilePath)

    await expect(
      replayLatestCliLogLines(paths.cliLogFilePath, fileStat.size, 10, createI18n('en'))
    ).resolves.toBeUndefined()
  })

  it('outputs all lines when lineCount exceeds total', async () => {
    await writeFile(paths.cliLogFilePath, makeJsonlContent(3))
    const { stat } = await import('node:fs/promises')
    const fileStat = await stat(paths.cliLogFilePath)

    const output = await captureStdout(async () => {
      await replayLatestCliLogLines(paths.cliLogFilePath, fileStat.size, 100, createI18n('en'))
    })

    const outputLines = output.trim().split('\n')
    expect(outputLines).toHaveLength(3)
  })

  it('skips invalid JSON lines and continues with valid ones', async () => {
    const mixedContent = [
      makeJsonlLine(0),
      'this is not json',
      makeJsonlLine(1),
      '{"incomplete":',
      makeJsonlLine(2),
    ].join('\n')
    const mixedContentFull = `${mixedContent}\n`
    await writeFile(paths.cliLogFilePath, mixedContentFull)
    const { stat } = await import('node:fs/promises')
    const fileStat = await stat(paths.cliLogFilePath)

    const output = await captureStdout(async () => {
      await replayLatestCliLogLines(paths.cliLogFilePath, fileStat.size, 100, createI18n('en'))
    })

    expect(output).toContain('line 0')
    expect(output).toContain('line 1')
    expect(output).toContain('line 2')
    expect(output).toContain('[invalid-cli-log]')
  })
})
