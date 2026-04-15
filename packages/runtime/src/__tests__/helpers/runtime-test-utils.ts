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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FakeListChatModel } from '@langchain/core/utils/testing'
import {
  type AggregatedMessageDeltaState,
  type AppMessage,
  type DomainEvent,
  type RunId,
  type RunSnapshot,
  type SessionId,
  applyMessageDelta,
} from '@tianji/shared'

import {
  type SessionRuntime,
  type SessionRuntimeDeepagentsConfig,
  type SessionRuntimeOptions,
  createSessionRuntime,
} from '../../runtime.js'
import { InMemorySnapshotStore } from '../../snapshot-store.js'
import {
  type RuntimeToolDefinition,
  type RuntimeToolSideEffect,
  type ToolCatalog,
  ToolRegistry,
} from '../../tool-catalog.js'

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

function createTestLlmRawDir(): string {
  return mkdtempSync(join(tmpdir(), 'tianji-runtime-raws-'))
}

/**
 * 为 runtime 测试统一注入临时 llmRawDir，避免污染用户配置目录。
 */
export function createTestRuntime(options: SessionRuntimeOptions): SessionRuntime {
  const deepagents =
    options.deepagents === undefined
      ? undefined
      : {
          ...options.deepagents,
          llmRawDir: options.deepagents.llmRawDir ?? createTestLlmRawDir(),
        }

  return createSessionRuntime({
    ...options,
    deepagents,
  })
}

export function createRuntimeHarness(options: DeepagentsHarnessOptions): SessionRuntime {
  return createTestRuntime({
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
): Promise<DomainEvent[]> {
  const events: DomainEvent[] = []

  for await (const event of runtime.streamEvents(runId)) {
    events.push(event)
  }

  return events
}

export async function collectRuntimeOutcome(
  runId: RunId,
  runtime: RuntimeUnderTest
): Promise<{ events: DomainEvent[]; error?: Error }> {
  const events: DomainEvent[] = []

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
  events: DomainEvent[]
  aggregatedAssistantMessage: AggregatedMessageDeltaState | undefined
}> {
  const events: DomainEvent[] = []
  let aggregatedAssistantMessage: AggregatedMessageDeltaState | undefined

  for await (const event of runtime.streamEvents(runId)) {
    events.push(event)

    if (event.type !== 'MessageDelta') {
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

// ---------------------------------------------------------------------------
// 集成测试工具函数
// ---------------------------------------------------------------------------

export interface MockToolOptions {
  readonly sideEffect?: RuntimeToolSideEffect
  readonly result?: unknown
  readonly error?: Error
  readonly delayMs?: number
}

/**
 * 创建一个用于测试的模拟工具定义。
 *
 * @param name - 工具名称
 * @param opts - 可选配置：副作用等级、返回值、抛出错误、延迟毫秒
 */
export function createMockTool(name: string, opts?: MockToolOptions): RuntimeToolDefinition {
  return {
    spec: {
      name,
      description: `Mock tool: ${name}`,
      parameters: { type: 'object' },
    },
    sideEffect: opts?.sideEffect ?? 'none',
    execute: async () => {
      if (opts?.delayMs !== undefined && opts.delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, opts.delayMs)
        })
      }

      if (opts?.error !== undefined) {
        throw opts.error
      }

      return opts?.result ?? 'ok'
    },
  }
}

/**
 * 快速创建包含指定工具定义的 ToolRegistry。
 */
export function createToolRegistry(...tools: RuntimeToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry()

  for (const tool of tools) {
    registry.registerTool(tool)
  }

  return registry
}

/**
 * 创建一个返回预设响应列表的假 LLM 模型。
 */
export function createFakeModel(responses: string[]): FakeListChatModel {
  return new FakeListChatModel({ responses })
}

/**
 * 顺序执行多轮对话，每轮发送一条用户消息并收集所有事件。
 *
 * @param runtime - 待测 SessionRuntime 实例
 * @param sessionId - 会话 ID
 * @param prompts - 每轮的消息 ID 与文本
 * @param options - 可选的系统提示
 */
export async function driveMultiTurn(
  runtime: SessionRuntime,
  sessionId: SessionId,
  prompts: Array<{ id: string; text: string }>,
  options?: { systemPrompt?: string }
): Promise<Array<{ runId: RunId; events: DomainEvent[] }>> {
  const results: Array<{ runId: RunId; events: DomainEvent[] }> = []

  for (const prompt of prompts) {
    const message = createUserMessage(prompt.id, prompt.text)
    const runId = await runtime.runTurn({
      sessionId,
      message,
      systemPrompt: options?.systemPrompt,
    })
    const events = await collectRuntimeEvents(runId, runtime)
    results.push({ runId, events })
  }

  return results
}

/**
 * 等待指定类型的事件出现在事件流中，超时则抛出错误。
 *
 * @param runtime - 待测 SessionRuntime 实例
 * @param runId - 运行 ID
 * @param eventType - 要等待的事件类型
 * @param timeoutMs - 超时毫秒数，默认 5000
 */
export async function waitForEvent(
  runtime: SessionRuntime,
  runId: RunId,
  eventType: DomainEvent['type'],
  timeoutMs = 5_000
): Promise<DomainEvent> {
  const deadline = Date.now() + timeoutMs

  for await (const event of runtime.streamEvents(runId)) {
    if (event.type === eventType) {
      return event
    }

    if (Date.now() > deadline) {
      break
    }
  }

  throw new Error(`Timed out waiting for event "${eventType}" on run "${runId}"`)
}

/**
 * 断言事件列表中包含 RunCompleted 且不含 RunFailed。
 */
export function assertRunCompleted(events: DomainEvent[]): void {
  const types = events.map((e) => e.type)
  expect(types).toContain('RunCompleted')
  expect(types).not.toContain('RunFailed')
}

/**
 * 断言事件列表中包含 RunFailed，可选匹配错误消息模式。
 */
export function assertRunFailed(events: DomainEvent[], errorPattern?: RegExp): void {
  const failedEvent = events.find((e) => e.type === 'RunFailed')
  expect(failedEvent).toBeDefined()

  if (errorPattern !== undefined && failedEvent?.type === 'RunFailed') {
    expect(failedEvent.error.message).toMatch(errorPattern)
  }
}

/**
 * 断言指定工具被调用且成功完成。
 */
export function assertToolCalled(events: DomainEvent[], toolName: string): void {
  const started = events.find((e) => e.type === 'ToolStarted' && e.invocation.toolName === toolName)
  expect(started).toBeDefined()

  if (started?.type === 'ToolStarted') {
    const completed = events.find(
      (e) => e.type === 'ToolCompleted' && e.toolCallId === started.toolCallId
    )
    expect(completed).toBeDefined()
  }
}

/**
 * 断言指定工具执行失败。
 */
export function assertToolFailed(events: DomainEvent[], toolName: string): void {
  const failed = events.find((e) => e.type === 'ToolFailed' && e.invocation.toolName === toolName)
  expect(failed).toBeDefined()
}
