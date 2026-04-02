import { describe, expect, expectTypeOf, it } from 'vitest'

import type {
  ObserverLogEntry,
  ObserverLogLevel,
  ObserverLogScope,
  ObserverLogSink,
  ObserverLogger,
} from '../../index.js'

describe('logger types', () => {
  it('log level and scope values are assignable', () => {
    const level: ObserverLogLevel = 'info'
    const scope: ObserverLogScope = ['cli', 'run']
    expect(level).toBe('info')
    expect(scope).toEqual(['cli', 'run'])
  })

  it('ObserverLogEntry has required fields', () => {
    const level: ObserverLogLevel = 'info'
    const scope: ObserverLogScope = ['cli', 'run']
    const entry: ObserverLogEntry = {
      timestamp: '2026-03-30T00:00:00.000Z',
      level,
      scope,
      message: 'message',
      data: { ok: true },
    }
    expect(entry.level).toBe('info')
    expect(entry.message).toBe('message')
    expect(entry.scope).toEqual(['cli', 'run'])
  })

  it('ObserverLogger interface has required method signatures', () => {
    expectTypeOf<ObserverLogger>().toHaveProperty('log')
    expectTypeOf<ObserverLogger>().toHaveProperty('trace')
    expectTypeOf<ObserverLogger>().toHaveProperty('debug')
    expectTypeOf<ObserverLogger>().toHaveProperty('info')
    expectTypeOf<ObserverLogger>().toHaveProperty('warn')
    expectTypeOf<ObserverLogger>().toHaveProperty('error')
    expectTypeOf<ObserverLogger>().toHaveProperty('fatal')
    expectTypeOf<ObserverLogger>().toHaveProperty('child')
  })

  it('ObserverLogSink interface has write method', () => {
    expectTypeOf<ObserverLogSink>().toHaveProperty('write')
  })
})
