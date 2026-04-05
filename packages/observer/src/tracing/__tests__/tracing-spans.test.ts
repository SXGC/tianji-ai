import { SpanKind, trace } from '@opentelemetry/api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initTracing, shutdownTracing } from '../index.js'
import { startLlmCallSpan, startRunSpan, startSessionSpan, startToolSpan } from '../spans.js'

afterEach(async () => {
  await shutdownTracing()
  vi.restoreAllMocks()
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
  /**
   * spans.ts always calls getTracer() which calls trace.getTracer('@tianji/observer').
   * We spy on the global trace.getTracer so that every call returns our
   * controlled mock tracer, allowing us to capture startSpan arguments.
   */
  let mockStartSpan: ReturnType<typeof vi.fn>
  let mockTracer: { startSpan: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    initTracing({ serviceName: '@tianji/observer', exporters: [] })

    // Build a fake span and tracer to intercept startSpan calls.
    const mockSpan = {
      end: vi.fn(),
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      spanContext: vi.fn().mockReturnValue({}),
      isRecording: vi.fn().mockReturnValue(true),
      setAttributes: vi.fn(),
      addEvent: vi.fn(),
      updateName: vi.fn(),
      addLink: vi.fn(),
    }
    mockStartSpan = vi.fn().mockReturnValue(mockSpan)
    mockTracer = { startSpan: mockStartSpan }

    // Intercept trace.getTracer so spans.ts receives our mock tracer.
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as never)
  })

  it('startSessionSpan sets tianji.session.id attribute', () => {
    const result = startSessionSpan({ sessionId: 'sess-1' })

    expect(result).toBeDefined()
    expect(mockStartSpan).toHaveBeenCalledWith(
      'session',
      expect.objectContaining({
        kind: SpanKind.INTERNAL,
        attributes: { 'tianji.session.id': 'sess-1' },
      })
    )
    result!.end()
  })

  it('startRunSpan sets tianji.run.id attribute', () => {
    const result = startRunSpan({ runId: 'run-1' })

    expect(result).toBeDefined()
    expect(mockStartSpan).toHaveBeenCalledWith(
      'run',
      expect.objectContaining({
        kind: SpanKind.INTERNAL,
        attributes: { 'tianji.run.id': 'run-1' },
      })
    )
    result!.end()
  })

  it('startRunSpan includes tianji.session.id when sessionId is provided', () => {
    const result = startRunSpan({ runId: 'run-1', sessionId: 'sess-1' })

    expect(result).toBeDefined()
    expect(mockStartSpan).toHaveBeenCalledWith(
      'run',
      expect.objectContaining({
        kind: SpanKind.INTERNAL,
        attributes: { 'tianji.run.id': 'run-1', 'tianji.session.id': 'sess-1' },
      })
    )
    result!.end()
  })

  it('startRunSpan omits tianji.session.id when sessionId is undefined', () => {
    const result = startRunSpan({ runId: 'run-1' })

    expect(result).toBeDefined()
    const attrs = mockStartSpan.mock.lastCall?.[1]?.attributes as Record<string, string> | undefined
    expect(attrs).toBeDefined()
    expect('tianji.session.id' in attrs!).toBe(false)
    result!.end()
  })

  it('startToolSpan sets tianji.tool.name attribute', () => {
    const result = startToolSpan({ toolName: 'file_search' })

    expect(result).toBeDefined()
    expect(mockStartSpan).toHaveBeenCalledWith(
      'tool',
      expect.objectContaining({
        kind: SpanKind.INTERNAL,
        attributes: { 'tianji.tool.name': 'file_search' },
      })
    )
    result!.end()
  })

  it('startToolSpan includes tianji.run.id when runId is provided', () => {
    const result = startToolSpan({ toolName: 'file_search', runId: 'run-1' })

    expect(result).toBeDefined()
    expect(mockStartSpan).toHaveBeenCalledWith(
      'tool',
      expect.objectContaining({
        kind: SpanKind.INTERNAL,
        attributes: { 'tianji.tool.name': 'file_search', 'tianji.run.id': 'run-1' },
      })
    )
    result!.end()
  })

  it('startToolSpan omits tianji.run.id when runId is undefined', () => {
    const result = startToolSpan({ toolName: 'file_search' })

    expect(result).toBeDefined()
    const attrs = mockStartSpan.mock.lastCall?.[1]?.attributes as Record<string, string> | undefined
    expect(attrs).toBeDefined()
    expect('tianji.run.id' in attrs!).toBe(false)
    result!.end()
  })

  it('startLlmCallSpan sets provider and model attributes', () => {
    const result = startLlmCallSpan({ provider: 'openai', model: 'gpt-4' })

    expect(result).toBeDefined()
    expect(mockStartSpan).toHaveBeenCalledWith(
      'llm.call',
      expect.objectContaining({
        kind: SpanKind.INTERNAL,
        attributes: { 'tianji.llm.provider': 'openai', 'tianji.llm.model': 'gpt-4' },
      })
    )
    result!.end()
  })

  it('startLlmCallSpan includes optional sessionId and runId', () => {
    const result = startLlmCallSpan({
      provider: 'anthropic',
      model: 'claude-3',
      sessionId: 'sess-1',
      runId: 'run-1',
    })

    expect(result).toBeDefined()
    expect(mockStartSpan).toHaveBeenCalledWith(
      'llm.call',
      expect.objectContaining({
        kind: SpanKind.INTERNAL,
        attributes: {
          'tianji.llm.provider': 'anthropic',
          'tianji.llm.model': 'claude-3',
          'tianji.session.id': 'sess-1',
          'tianji.run.id': 'run-1',
        },
      })
    )
    result!.end()
  })

  it('startLlmCallSpan omits sessionId and runId when undefined', () => {
    const result = startLlmCallSpan({ provider: 'openai', model: 'gpt-4' })

    expect(result).toBeDefined()
    const attrs = mockStartSpan.mock.lastCall?.[1]?.attributes as Record<string, string> | undefined
    expect(attrs).toBeDefined()
    expect('tianji.session.id' in attrs!).toBe(false)
    expect('tianji.run.id' in attrs!).toBe(false)
    result!.end()
  })

  it('startLlmCallSpan includes only sessionId when runId is undefined', () => {
    const result = startLlmCallSpan({ provider: 'openai', model: 'gpt-4', sessionId: 'sess-1' })

    expect(result).toBeDefined()
    const attrs = mockStartSpan.mock.lastCall?.[1]?.attributes as Record<string, string> | undefined
    expect(attrs).toBeDefined()
    expect(attrs!['tianji.session.id']).toBe('sess-1')
    expect('tianji.run.id' in attrs!).toBe(false)
    result!.end()
  })

  it('startLlmCallSpan includes only runId when sessionId is undefined', () => {
    const result = startLlmCallSpan({ provider: 'openai', model: 'gpt-4', runId: 'run-1' })

    expect(result).toBeDefined()
    const attrs = mockStartSpan.mock.lastCall?.[1]?.attributes as Record<string, string> | undefined
    expect(attrs).toBeDefined()
    expect(attrs!['tianji.run.id']).toBe('run-1')
    expect('tianji.session.id' in attrs!).toBe(false)
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
