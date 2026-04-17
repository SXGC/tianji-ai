import { afterEach, describe, expect, it, vi } from 'vitest'

import { createStderrSink } from '../sinks/stderr.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createStderrSink', () => {
  it('writes JSON line to process.stderr by default', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const sink = createStderrSink()

    await sink.write({
      timestamp: '2026-04-17T00:00:00.000Z',
      level: 'error',
      scope: ['cp'],
      message: 'boom',
    })

    expect(writeSpy).toHaveBeenCalledTimes(1)
    const written = writeSpy.mock.calls[0]?.[0] as string
    expect(written.endsWith('\n')).toBe(true)
    expect(JSON.parse(written.trimEnd())).toMatchObject({
      level: 'error',
      message: 'boom',
    })
  })

  it('supports pretty formatting', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const sink = createStderrSink({ pretty: true })

    await sink.write({
      timestamp: '2026-04-17T00:00:00.000Z',
      level: 'warn',
      scope: ['cp', 'server'],
      message: 'slow',
    })

    const written = writeSpy.mock.calls[0]?.[0] as string
    expect(written).toContain('[warn]')
    expect(written).toContain('cp.server')
    expect(written).toContain('slow')
  })

  it('filters entries below minLevel', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const sink = createStderrSink({ minLevel: 'warn' })

    await sink.write({
      timestamp: '2026-04-17T00:00:00.000Z',
      level: 'info',
      scope: ['cp'],
      message: 'noise',
    })
    expect(writeSpy).not.toHaveBeenCalled()

    await sink.write({
      timestamp: '2026-04-17T00:00:00.000Z',
      level: 'error',
      scope: ['cp'],
      message: 'real',
    })
    expect(writeSpy).toHaveBeenCalledTimes(1)
  })
})
