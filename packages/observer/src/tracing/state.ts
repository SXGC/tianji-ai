import type { ObserverTracingState } from './types.js'

let tracingState: ObserverTracingState | undefined

/**
 * Returns the current tracing handle when tracing was initialized.
 */
export function getTracingState(): ObserverTracingState | undefined {
  return tracingState
}

/**
 * Replaces the current tracing handle.
 */
export function setTracingState(state: ObserverTracingState | undefined): void {
  tracingState = state
}

/**
 * Indicates whether tracing is currently enabled.
 */
export function hasTracingState(): boolean {
  return tracingState !== undefined
}
