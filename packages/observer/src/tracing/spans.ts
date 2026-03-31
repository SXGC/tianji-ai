import { SpanKind } from '@opentelemetry/api'

import { getTracer } from './tracer.js'
import type {
  ObserverLlmCallSpanInput,
  ObserverRunSpanInput,
  ObserverSessionSpanInput,
  ObserverStartedSpan,
  ObserverToolSpanInput,
} from './types.js'

/**
 * Starts a top-level session span.
 */
export function startSessionSpan(input: ObserverSessionSpanInput): ObserverStartedSpan | undefined {
  return startSpan('session', {
    'tianji.session.id': input.sessionId,
  })
}

/**
 * Starts a run span.
 */
export function startRunSpan(input: ObserverRunSpanInput): ObserverStartedSpan | undefined {
  return startSpan('run', {
    'tianji.run.id': input.runId,
    ...(input.sessionId === undefined ? {} : { 'tianji.session.id': input.sessionId }),
  })
}

/**
 * Starts a tool execution span.
 */
export function startToolSpan(input: ObserverToolSpanInput): ObserverStartedSpan | undefined {
  return startSpan('tool', {
    'tianji.tool.name': input.toolName,
    ...(input.runId === undefined ? {} : { 'tianji.run.id': input.runId }),
  })
}

/**
 * Starts an llm call span.
 */
export function startLlmCallSpan(input: ObserverLlmCallSpanInput): ObserverStartedSpan | undefined {
  return startSpan('llm.call', {
    'tianji.llm.provider': input.provider,
    'tianji.llm.model': input.model,
    ...(input.sessionId === undefined ? {} : { 'tianji.session.id': input.sessionId }),
    ...(input.runId === undefined ? {} : { 'tianji.run.id': input.runId }),
  })
}

function startSpan(
  name: string,
  attributes: Record<string, string>
): ObserverStartedSpan | undefined {
  const tracer = getTracer()
  if (tracer === undefined) {
    return undefined
  }

  const span = tracer.startSpan(name, {
    kind: SpanKind.INTERNAL,
    attributes,
  })

  return {
    span,
    end: () => span.end(),
  }
}
