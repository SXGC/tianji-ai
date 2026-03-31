import type { Context, Span, Tracer } from '@opentelemetry/api'

export interface ObserverTracingExporterConfig {
  readonly kind: 'otlp' | 'langfuse'
  readonly endpoint?: string
  readonly headers?: Record<string, string>
}

export interface ObserverTracingConfig {
  readonly serviceName: string
  readonly exporters: readonly ObserverTracingExporterConfig[]
}

export interface ObserverTracingState {
  readonly tracer: Tracer
  readonly shutdown: () => Promise<void>
}

export interface ObserverSessionSpanInput {
  readonly sessionId: string
  readonly parentContext?: Context
}

export interface ObserverRunSpanInput {
  readonly runId: string
  readonly sessionId?: string
  readonly parentContext?: Context
}

export interface ObserverToolSpanInput {
  readonly toolName: string
  readonly runId?: string
  readonly parentContext?: Context
}

export interface ObserverLlmCallSpanInput {
  readonly provider: string
  readonly model: string
  readonly sessionId?: string
  readonly runId?: string
  readonly parentContext?: Context
}

export interface ObserverStartedSpan {
  readonly span: Span
  readonly end: () => void
}
