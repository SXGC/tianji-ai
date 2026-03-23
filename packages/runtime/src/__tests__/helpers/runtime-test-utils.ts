/**
 * runtime 测试辅助工具。
 *
 * 业务职责：
 * - 为 runtime 测试统一提供 harness、事件采集、消息构造与运行状态轮询能力。
 * - 降低各测试文件的样板代码，确保事件断言方式一致。
 *
 * 对外触点：
 * - 被 packages/runtime/src/__tests__ 下多个集成与回归测试直接复用。
 * - 依赖 runtime、snapshot-store、tool-catalog 的公开接口构建测试上下文。
 */
import {
  type AggregatedMessageDeltaState,
  type AppMessage,
  type RunId,
  type RunSnapshot,
  type RuntimeEvent,
  applyMessageDelta,
} from '@tianji/contracts'

import {
  type SessionRuntime,
  type SessionRuntimeDeepagentsConfig,
  createSessionRuntime,
} from '../../runtime.js'
import { InMemorySnapshotStore } from '../../snapshot-store.js'
import { type ToolCatalog, ToolRegistry } from '../../tool-catalog.js'

export interface Deferred<T> {
  readonly promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

type RuntimeUnderTest = SessionRuntime

type DeepagentsHarnessOptions = {
  readonly deepagents: SessionRuntimeDeepagentsConfig
  readonly snapshotStore?: InMemorySnapshotStore
  readonly toolCatalog?: ToolCatalog
}

export function createRuntimeHarness(options: DeepagentsHarnessOptions): SessionRuntime {
  return createSessionRuntime({
    deepagents: options.deepagents,
    snapshotStore: options.snapshotStore ?? new InMemorySnapshotStore(),
    toolCatalog: options.toolCatalog ?? new ToolRegistry(),
  })
}

export function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined
  let reject: ((reason?: unknown) => void) | undefined
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  if (resolve === undefined || reject === undefined) {
    throw new Error('Failed to create deferred promise')
  }

  return { promise, resolve, reject }
}

export function createAbortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export async function collectRuntimeEvents(
  runId: RunId,
  runtime: RuntimeUnderTest
): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []

  for await (const event of runtime.streamEvents(runId)) {
    events.push(event)
  }

  return events
}

export async function collectRuntimeOutcome(
  runId: RunId,
  runtime: RuntimeUnderTest
): Promise<{ events: RuntimeEvent[]; error?: Error }> {
  const events: RuntimeEvent[] = []

  try {
    for await (const event of runtime.streamEvents(runId)) {
      events.push(event)
    }

    return { events }
  } catch (error) {
    return {
      events,
      error: error instanceof Error ? error : new Error(String(error)),
    }
  }
}

export async function collectRuntimeEventsWithAggregation(
  runId: RunId,
  runtime: RuntimeUnderTest
): Promise<{
  events: RuntimeEvent[]
  aggregatedAssistantMessage: AggregatedMessageDeltaState | undefined
}> {
  const events: RuntimeEvent[] = []
  let aggregatedAssistantMessage: AggregatedMessageDeltaState | undefined

  for await (const event of runtime.streamEvents(runId)) {
    events.push(event)

    if (event.type !== 'message.delta') {
      continue
    }

    // 复用 contracts 中的 delta 聚合逻辑，确保测试侧与产品侧按同一规则还原流式消息。
    aggregatedAssistantMessage = applyMessageDelta(aggregatedAssistantMessage, {
      runId: event.runId,
      messageId: event.messageId,
      sequence: event.sequence,
      op: 'append',
      channel: event.channel,
      payload: event.payload.content,
      timestamp: event.timestamp,
    })
  }

  return {
    events,
    aggregatedAssistantMessage,
  }
}

export function createUserMessage(id: string, text: string): AppMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    createdAt: 1,
  }
}

export function readTextContent(message: AppMessage | undefined): string {
  if (message === undefined) {
    return ''
  }

  return message.content
    .filter(
      (part): part is Extract<AppMessage['content'][number], { type: 'text' }> =>
        part.type === 'text'
    )
    .map((part) => part.text)
    .join('')
}

export async function waitForRunStatus(
  runtime: RuntimeUnderTest,
  runId: RunId,
  status: RunSnapshot['status']
): Promise<RunSnapshot> {
  // 轮询封装统一了异步 run 状态断言，避免各测试散落不同的等待策略。
  const timeoutAt = Date.now() + 2_000

  while (Date.now() < timeoutAt) {
    const snapshot = await runtime.getRunSnapshot(runId)

    if (snapshot?.status === status) {
      return snapshot
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  }

  const snapshot = await runtime.getRunSnapshot(runId)
  throw new Error(
    `Timed out waiting for run "${runId}" to reach status "${status}". Last status: ${snapshot?.status ?? 'missing'}`
  )
}
