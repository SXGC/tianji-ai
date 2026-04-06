import { createMemorySink } from '@tianji/observer'
import { describe, expect, it } from 'vitest'

import { createControlPlaneLogger } from '../logger.js'

describe('createControlPlaneLogger', () => {
  it('should write log entries to all provided sinks', async () => {
    const sink = createMemorySink()
    const logger = createControlPlaneLogger({ sinks: [sink] })

    await logger.info(['controlplane', 'test'], 'hello')

    expect(sink.entries).toHaveLength(1)
    expect(sink.entries[0].level).toBe('info')
    expect(sink.entries[0].scope).toEqual(['controlplane', 'test'])
    expect(sink.entries[0].message).toBe('hello')
  })

  it('should attach structured data to log entry', async () => {
    const sink = createMemorySink()
    const logger = createControlPlaneLogger({ sinks: [sink] })

    await logger.info(['controlplane', 'register'], 'node registered', {
      nodeId: 'n1',
    })

    expect(sink.entries[0].data).toEqual({ nodeId: 'n1' })
  })

  it('should support debug level', async () => {
    const sink = createMemorySink()
    const logger = createControlPlaneLogger({ sinks: [sink] })

    await logger.debug(['controlplane', 'heartbeat'], 'heartbeat received')

    expect(sink.entries[0].level).toBe('debug')
  })

  it('should support warn level', async () => {
    const sink = createMemorySink()
    const logger = createControlPlaneLogger({ sinks: [sink] })

    await logger.warn(['controlplane', 'auth'], 'invalid token')

    expect(sink.entries[0].level).toBe('warn')
  })
})
