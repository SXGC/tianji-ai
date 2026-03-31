import { afterEach, describe, expect, it } from 'vitest'

import { getTracer, initTracing, isTracingEnabled, shutdownTracing } from '../index.js'

afterEach(async () => {
  await shutdownTracing()
})

describe('tracing lifecycle', () => {
  it('returns undefined tracer before init', () => {
    expect(isTracingEnabled()).toBe(false)
    expect(getTracer()).toBeUndefined()
  })

  it('initializes and shuts down without unexpected errors', async () => {
    const dispose = initTracing({ serviceName: 'tianji-cli', exporters: [] })

    expect(isTracingEnabled()).toBe(true)

    expect(getTracer('test')).toBeDefined()

    await dispose()
    await shutdownTracing()

    expect(isTracingEnabled()).toBe(false)
  })
})
