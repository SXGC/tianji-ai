import { trace } from '@opentelemetry/api'

import { getTracingState, hasTracingState, setTracingState } from './state.js'
import type { ObserverTracingConfig } from './types.js'

const DEFAULT_TRACER_NAME = '@tianji/observer'

/**
 * Initializes tracing explicitly and stores the process-wide tracing state.
 */
export function initTracing(config: ObserverTracingConfig): () => Promise<void> {
  assertExportersSupported(config)

  const existingState = getTracingState()
  if (existingState !== undefined) {
    return existingState.shutdown
  }

  const shutdown = async () => {
    setTracingState(undefined)
  }

  setTracingState({
    tracer: trace.getTracer(config.serviceName || DEFAULT_TRACER_NAME),
    shutdown,
  })

  return shutdown
}

/**
 * Shuts down the active tracing handle and clears global state.
 */
export async function shutdownTracing(): Promise<void> {
  const state = getTracingState()

  if (state !== undefined) {
    await state.shutdown()
  }
}

/**
 * Returns whether tracing has been initialized.
 */
export function isTracingEnabled(): boolean {
  return hasTracingState()
}

/**
 * Returns the active tracer once tracing was initialized.
 */
export function getTracer(name = DEFAULT_TRACER_NAME) {
  const state = getTracingState()
  if (state === undefined) {
    return undefined
  }

  return trace.getTracer(name)
}

function assertExportersSupported(config: ObserverTracingConfig): void {
  for (const exporter of config.exporters) {
    if (exporter.kind === 'langfuse') {
      throw new Error('Tracing exporter "langfuse" is not connected yet')
    }
  }
}
