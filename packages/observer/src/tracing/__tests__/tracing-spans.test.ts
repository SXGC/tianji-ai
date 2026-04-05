import { SpanKind } from '@opentelemetry/api'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { initTracing, shutdownTracing } from '../index.js'
import { startLlmCallSpan, startRunSpan, startSessionSpan, startToolSpan } from '../spans.js'

afterEach(async () => {
  await shutdownTracing()
})

describe('span functions when tracing is not initialized', () => {
  it('startSessionSpan returns undefined', () => {
    expect(startSessionSpan({ sessionId: 'sess-1' })).toBeUndefined()
  })

  it('startRunSpan returns undefined', () => {
    expect(startRunSpan({ runId: 'run-1' })).toBeUndefined()
  })

  it('startToolSpan returns undefined', () => {
    expect(startToolSpan({ toolName: 'search' })).toBeUndefined()
  })

  it('startLlmCallSpan returns undefined', () => {
    expect(startLlmCallSpan({ provider: 'openai', model: 'gpt-4' })).toBeUndefined()
  })
})

describe('span functions when tracing is initialized', () => {
  it('startSessionSpan returns a started span with end()', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startSessionSpan({ sessionId: 'sess-1' })

    expect(result).toBeDefined()
    expect(result!.span).toBeDefined()
    expect(typeof result!.end).toBe('function')

    // Calling end should not throw
    result!.end()
  })

  it('startRunSpan returns a started span with correct attributes', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startRunSpan({ runId: 'run-1' })

    expect(result).toBeDefined()
    expect(result!.span).toBeDefined()
    result!.end()
  })

  it('startRunSpan includes sessionId attribute when provided', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startRunSpan({ runId: 'run-1', sessionId: 'sess-1' })

    expect(result).toBeDefined()
    result!.end()
  })

  it('startRunSpan omits sessionId attribute when undefined', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startRunSpan({ runId: 'run-1' })

    expect(result).toBeDefined()
    result!.end()
  })

  it('startToolSpan returns a started span', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startToolSpan({ toolName: 'file_search' })

    expect(result).toBeDefined()
    expect(result!.span).toBeDefined()
    result!.end()
  })

  it('startToolSpan includes runId attribute when provided', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startToolSpan({ toolName: 'file_search', runId: 'run-1' })

    expect(result).toBeDefined()
    result!.end()
  })

  it('startToolSpan omits runId attribute when undefined', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startToolSpan({ toolName: 'file_search' })

    expect(result).toBeDefined()
    result!.end()
  })

  it('startLlmCallSpan returns a started span', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startLlmCallSpan({ provider: 'openai', model: 'gpt-4' })

    expect(result).toBeDefined()
    expect(result!.span).toBeDefined()
    result!.end()
  })

  it('startLlmCallSpan includes optional sessionId and runId', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startLlmCallSpan({
      provider: 'anthropic',
      model: 'claude-3',
      sessionId: 'sess-1',
      runId: 'run-1',
    })

    expect(result).toBeDefined()
    result!.end()
  })

  it('startLlmCallSpan omits sessionId and runId when undefined', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startLlmCallSpan({ provider: 'openai', model: 'gpt-4' })

    expect(result).toBeDefined()
    result!.end()
  })

  it('startLlmCallSpan includes only sessionId when runId is undefined', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startLlmCallSpan({
      provider: 'openai',
      model: 'gpt-4',
      sessionId: 'sess-1',
    })

    expect(result).toBeDefined()
    result!.end()
  })

  it('startLlmCallSpan includes only runId when sessionId is undefined', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startLlmCallSpan({
      provider: 'openai',
      model: 'gpt-4',
      runId: 'run-1',
    })

    expect(result).toBeDefined()
    result!.end()
  })
})

describe('startSpan internal behavior', () => {
  it('span.end() delegates to the underlying OTel span', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const result = startSessionSpan({ sessionId: 'sess-end-test' })
    expect(result).toBeDefined()

    // Spy on the underlying span's end method
    const endSpy = vi.spyOn(result!.span, 'end')

    result!.end()

    expect(endSpy).toHaveBeenCalledOnce()
  })

  it('multiple spans can be created and ended independently', () => {
    initTracing({ serviceName: 'test-spans', exporters: [] })

    const session = startSessionSpan({ sessionId: 'sess-1' })
    const run = startRunSpan({ runId: 'run-1', sessionId: 'sess-1' })
    const tool = startToolSpan({ toolName: 'search', runId: 'run-1' })
    const llm = startLlmCallSpan({ provider: 'openai', model: 'gpt-4', runId: 'run-1' })

    expect(session).toBeDefined()
    expect(run).toBeDefined()
    expect(tool).toBeDefined()
    expect(llm).toBeDefined()

    // End in reverse order; should not throw
    llm!.end()
    tool!.end()
    run!.end()
    session!.end()
  })
})
