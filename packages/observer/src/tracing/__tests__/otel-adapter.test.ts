import { SpanKind, trace } from '@opentelemetry/api'
import type { DomainEventEnvelope } from '@tianji/shared'
import { TianjiError, ToolError, createEventBus } from '@tianji/shared'
import type { RunCompletedEvent, RunFailedEvent, RunStartedEvent } from '@tianji/shared'
import type { ToolCompletedEvent, ToolFailedEvent, ToolStartedEvent } from '@tianji/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initTracing, shutdownTracing } from '../index.js'
import { handleSpanEvent, subscribeOtelAdapter } from '../otel-adapter.js'

// ─── helpers ─────────────────────────────────────────────────────────────────

const flush = () => new Promise<void>((resolve) => queueMicrotask(() => resolve()))

/**
 * 构造最小 DomainEventEnvelope，payload 类型通过 unknown 双转绕过严格品牌类型检查。
 * 测试目的是验证 adapter 行为，不需要完全合法的 branded 运行时值。
 */
function mkEnvelope(payload: Record<string, unknown>): DomainEventEnvelope {
  return {
    eventId: 'evt-1',
    type: payload.type as string,
    occurredAt: '2026-04-14T00:00:00Z',
    correlationId: 'corr-1',
    causationId: 'cause-1',
    sequence: 1,
    aggregateType: 'Run',
    aggregateId: 'run-1',
    source: { processKind: 'node', processId: 'pid-1' },
    payload,
  } as unknown as DomainEventEnvelope
}

/** 在 mock.calls 里查找包含指定 key 的 attributes 调用 */
function findAttrsCallWith(
  mockFn: ReturnType<typeof vi.fn>,
  key: string
): Record<string, string> | undefined {
  const call = mockFn.mock.calls.find(
    (args: unknown[]) =>
      typeof args[0] === 'object' && args[0] !== null && key in (args[0] as object)
  )
  return call?.[0] as Record<string, string> | undefined
}

// ─── suite ───────────────────────────────────────────────────────────────────

afterEach(async () => {
  await shutdownTracing()
  vi.restoreAllMocks()
})

describe('handleSpanEvent — tracing not initialized', () => {
  it('RunStarted: 静默跳过，不抛出', () => {
    const payload: RunStartedEvent = {
      type: 'RunStarted',
      runId: 'run-1' as never,
      sessionId: 'sess-1' as never,
      triggerType: 'new',
      timestamp: Date.now(),
    }
    expect(() =>
      handleSpanEvent(mkEnvelope(payload as unknown as Record<string, unknown>))
    ).not.toThrow()
  })

  it('ToolStarted: 静默跳过，不抛出', () => {
    const payload: ToolStartedEvent = {
      type: 'ToolStarted',
      runId: 'run-1' as never,
      toolCallId: 'tc-1',
      invocation: { toolCallId: 'tc-1', toolName: 'search', args: {} },
      timestamp: Date.now(),
    }
    expect(() =>
      handleSpanEvent(mkEnvelope(payload as unknown as Record<string, unknown>))
    ).not.toThrow()
  })
})

describe('handleSpanEvent — tracing initialized', () => {
  let mockStartSpan: ReturnType<typeof vi.fn>
  let mockSetAttributes: ReturnType<typeof vi.fn>
  let mockEnd: ReturnType<typeof vi.fn>

  beforeEach(() => {
    initTracing({ serviceName: '@tianji/observer', exporters: [] })

    mockEnd = vi.fn()
    mockSetAttributes = vi.fn()

    const mockSpan = {
      end: mockEnd,
      setAttribute: vi.fn(),
      setAttributes: mockSetAttributes,
      setStatus: vi.fn(),
      recordException: vi.fn(),
      spanContext: vi.fn().mockReturnValue({}),
      isRecording: vi.fn().mockReturnValue(true),
      addEvent: vi.fn(),
      updateName: vi.fn(),
      addLink: vi.fn(),
    }
    mockStartSpan = vi.fn().mockReturnValue(mockSpan)
    const mockTracer = { startSpan: mockStartSpan }
    vi.spyOn(trace, 'getTracer').mockReturnValue(mockTracer as never)
  })

  it('RunStarted: 创建 run span，写入 runId 与 envelope 字段', () => {
    const payload: RunStartedEvent = {
      type: 'RunStarted',
      runId: 'run-abc' as never,
      sessionId: 'sess-abc' as never,
      triggerType: 'new',
      timestamp: Date.now(),
    }
    handleSpanEvent(mkEnvelope(payload as unknown as Record<string, unknown>))

    expect(mockStartSpan).toHaveBeenCalledWith(
      'run',
      expect.objectContaining({
        kind: SpanKind.INTERNAL,
        attributes: expect.objectContaining({ 'tianji.run.id': 'run-abc' }),
      })
    )
    const envelopeAttrs = findAttrsCallWith(mockSetAttributes, 'tianji.event.id')
    expect(envelopeAttrs).toBeDefined()
    expect(envelopeAttrs!['tianji.event.id']).toBe('evt-1')
    expect(envelopeAttrs!['tianji.event.correlation_id']).toBe('corr-1')
    expect(envelopeAttrs!['tianji.event.causation_id']).toBe('cause-1')
    expect(mockEnd).toHaveBeenCalledOnce()
  })

  it('RunCompleted: span 包含 tianji.run.status=completed', () => {
    const payload: RunCompletedEvent = {
      type: 'RunCompleted',
      runId: 'run-abc' as never,
      sessionId: 'sess-abc' as never,
      triggerType: 'new',
      timestamp: Date.now(),
    }
    handleSpanEvent(mkEnvelope(payload as unknown as Record<string, unknown>))

    const statusAttrs = findAttrsCallWith(mockSetAttributes, 'tianji.run.status')
    expect(statusAttrs).toBeDefined()
    expect(statusAttrs!['tianji.run.status']).toBe('completed')
  })

  it('RunFailed: span 包含 tianji.run.status=failed 与 error_code', () => {
    const error = new TianjiError('internal', 'ERR_TIMEOUT', 'timeout')
    const payload: RunFailedEvent = {
      type: 'RunFailed',
      runId: 'run-abc' as never,
      sessionId: 'sess-abc' as never,
      triggerType: 'new',
      timestamp: Date.now(),
      error,
    }
    handleSpanEvent(mkEnvelope(payload as unknown as Record<string, unknown>))

    const statusAttrs = findAttrsCallWith(mockSetAttributes, 'tianji.run.status')
    expect(statusAttrs).toBeDefined()
    expect(statusAttrs!['tianji.run.status']).toBe('failed')
    expect(statusAttrs!['tianji.run.error_code']).toBe('ERR_TIMEOUT')
  })

  it('ToolStarted: 创建 tool span，写入 toolName / runId / callId', () => {
    const payload: ToolStartedEvent = {
      type: 'ToolStarted',
      runId: 'run-abc' as never,
      toolCallId: 'tc-1',
      invocation: { toolCallId: 'tc-1', toolName: 'file_search', args: {} },
      timestamp: Date.now(),
    }
    handleSpanEvent(mkEnvelope(payload as unknown as Record<string, unknown>))

    expect(mockStartSpan).toHaveBeenCalledWith(
      'tool',
      expect.objectContaining({
        kind: SpanKind.INTERNAL,
        attributes: expect.objectContaining({
          'tianji.tool.name': 'file_search',
          'tianji.run.id': 'run-abc',
        }),
      })
    )
    const callIdAttrs = findAttrsCallWith(mockSetAttributes, 'tianji.tool.call_id')
    expect(callIdAttrs).toBeDefined()
    expect(callIdAttrs!['tianji.tool.call_id']).toBe('tc-1')
  })

  it('ToolCompleted: span 包含 tianji.tool.status=completed', () => {
    const payload: ToolCompletedEvent = {
      type: 'ToolCompleted',
      runId: 'run-abc' as never,
      toolCallId: 'tc-2',
      invocation: { toolCallId: 'tc-2', toolName: 'calculator', args: {} },
      result: { toolCallId: 'tc-2', result: 42 },
      timestamp: Date.now(),
    }
    handleSpanEvent(mkEnvelope(payload as unknown as Record<string, unknown>))

    const statusAttrs = findAttrsCallWith(mockSetAttributes, 'tianji.tool.status')
    expect(statusAttrs).toBeDefined()
    expect(statusAttrs!['tianji.tool.status']).toBe('completed')
  })

  it('ToolFailed: span 包含 tianji.tool.status=failed 与 error_code', () => {
    const error = new ToolError('EXEC_FAILED', 'tool error')
    const payload: ToolFailedEvent = {
      type: 'ToolFailed',
      runId: 'run-abc' as never,
      toolCallId: 'tc-3',
      invocation: { toolCallId: 'tc-3', toolName: 'executor', args: {} },
      error,
      timestamp: Date.now(),
    }
    handleSpanEvent(mkEnvelope(payload as unknown as Record<string, unknown>))

    const statusAttrs = findAttrsCallWith(mockSetAttributes, 'tianji.tool.status')
    expect(statusAttrs).toBeDefined()
    expect(statusAttrs!['tianji.tool.status']).toBe('failed')
    expect(statusAttrs!['tianji.tool.error_code']).toBe('EXEC_FAILED')
  })

  it('causationId 为 null 时不写入 tianji.event.causation_id', () => {
    const payload: RunStartedEvent = {
      type: 'RunStarted',
      runId: 'run-abc' as never,
      sessionId: 'sess-abc' as never,
      triggerType: 'new',
      timestamp: Date.now(),
    }
    const env = mkEnvelope(payload as unknown as Record<string, unknown>)
    const envWithNullCausation = { ...env, causationId: null } as DomainEventEnvelope
    handleSpanEvent(envWithNullCausation)

    const envelopeAttrs = findAttrsCallWith(mockSetAttributes, 'tianji.event.id')
    expect(envelopeAttrs).toBeDefined()
    expect('tianji.event.causation_id' in envelopeAttrs!).toBe(false)
  })

  it('未知事件类型：不创建 span，不抛出', () => {
    const unknownEnv = {
      eventId: 'evt-x',
      type: 'UnknownEvent',
      occurredAt: '2026-04-14T00:00:00Z',
      correlationId: 'c1',
      causationId: null,
      sequence: 1,
      aggregateType: 'Run',
      aggregateId: 'r1',
      source: { processKind: 'node', processId: 'p1' },
      payload: { type: 'UnknownEvent' },
    } as unknown as DomainEventEnvelope
    expect(() => handleSpanEvent(unknownEnv)).not.toThrow()
    expect(mockStartSpan).not.toHaveBeenCalled()
  })
})

describe('subscribeOtelAdapter — bus 集成', () => {
  it('订阅后 publish RunStarted 触发 handleSpanEvent', async () => {
    initTracing({ serviceName: '@tianji/observer', exporters: [] })

    const mockEnd = vi.fn()
    const mockSetAttributes = vi.fn()
    const mockSpan = {
      end: mockEnd,
      setAttribute: vi.fn(),
      setAttributes: mockSetAttributes,
      setStatus: vi.fn(),
      recordException: vi.fn(),
      spanContext: vi.fn().mockReturnValue({}),
      isRecording: vi.fn().mockReturnValue(true),
      addEvent: vi.fn(),
      updateName: vi.fn(),
      addLink: vi.fn(),
    }
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startSpan: vi.fn().mockReturnValue(mockSpan),
    } as never)

    const bus = createEventBus({ lagSink: vi.fn(), errorSink: vi.fn() })
    const handle = subscribeOtelAdapter(bus)

    const payload: RunStartedEvent = {
      type: 'RunStarted',
      runId: 'run-bus' as never,
      sessionId: 'sess-bus' as never,
      triggerType: 'new',
      timestamp: Date.now(),
    }
    bus.publish(mkEnvelope(payload as unknown as Record<string, unknown>))
    await flush()

    expect(mockEnd).toHaveBeenCalledOnce()
    handle.unsubscribe()
  })

  it('仅订阅指定事件类型，RunCancelled 不触发 span', async () => {
    initTracing({ serviceName: '@tianji/observer', exporters: [] })

    const mockStartSpanFn = vi.fn()
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startSpan: mockStartSpanFn,
    } as never)

    const bus = createEventBus({ lagSink: vi.fn(), errorSink: vi.fn() })
    const handle = subscribeOtelAdapter(bus)

    const env = {
      eventId: 'evt-c',
      type: 'RunCancelled',
      occurredAt: '2026-04-14T00:00:00Z',
      correlationId: 'c1',
      causationId: null,
      sequence: 1,
      aggregateType: 'Run',
      aggregateId: 'r1',
      source: { processKind: 'node', processId: 'p1' },
      payload: {
        type: 'RunCancelled',
        runId: 'r1',
        sessionId: 's1',
        triggerType: 'new',
        timestamp: 0,
        reason: 'abort',
      },
    } as unknown as DomainEventEnvelope
    bus.publish(env)
    await flush()

    // RunCancelled 不在 filter 列表里，bus 不会投递，startSpan 不应被调用
    expect(mockStartSpanFn).not.toHaveBeenCalled()
    handle.unsubscribe()
  })

  it('unsubscribe 后事件不再触发 span', async () => {
    initTracing({ serviceName: '@tianji/observer', exporters: [] })

    const mockStartSpanFn = vi.fn().mockReturnValue({
      end: vi.fn(),
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
      recordException: vi.fn(),
      spanContext: vi.fn().mockReturnValue({}),
      isRecording: vi.fn().mockReturnValue(true),
      addEvent: vi.fn(),
      updateName: vi.fn(),
      addLink: vi.fn(),
    })
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startSpan: mockStartSpanFn,
    } as never)

    const bus = createEventBus({ lagSink: vi.fn(), errorSink: vi.fn() })
    const handle = subscribeOtelAdapter(bus)
    handle.unsubscribe()

    const payload: RunStartedEvent = {
      type: 'RunStarted',
      runId: 'run-bus' as never,
      sessionId: 'sess-bus' as never,
      triggerType: 'new',
      timestamp: Date.now(),
    }
    bus.publish(mkEnvelope(payload as unknown as Record<string, unknown>))
    await flush()

    expect(mockStartSpanFn).not.toHaveBeenCalled()
  })
})
