import type { ObserverLogSink, ObserverLogger } from '@tianji/observer'
import { createObserverLogger } from '@tianji/observer'

export interface CreateControlPlaneLoggerOptions {
  readonly sinks: readonly ObserverLogSink[]
}

/**
 * 创建 controlplane 专用的结构化 logger。
 *
 * @param options - sink 列表，通常包含文件 sink 和 stdout sink
 */
export function createControlPlaneLogger(options: CreateControlPlaneLoggerOptions): ObserverLogger {
  return createObserverLogger({ sinks: options.sinks })
}
