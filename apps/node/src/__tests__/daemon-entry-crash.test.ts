import { describe, expect, it } from 'vitest'

import { buildDaemonCrashLogData } from '../daemon-entry.js'

describe('buildDaemonCrashLogData', () => {
  it('includes stack and cause for Error objects', () => {
    const cause = new Error('inner')
    const error = new Error('outer', { cause })
    const data = buildDaemonCrashLogData(error)

    expect(data).toMatchObject({
      name: 'Error',
      message: 'outer',
    })
    expect(typeof data.stack).toBe('string')
    expect(data.stack).toContain('outer')
    expect(data.cause).toMatchObject({ name: 'Error', message: 'inner' })
  })

  it('falls back to string coercion for non-Error throws', () => {
    const data = buildDaemonCrashLogData('boom')
    expect(data).toMatchObject({ message: 'boom' })
  })
})
