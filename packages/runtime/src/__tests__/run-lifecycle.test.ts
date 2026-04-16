/**
 * handleRunFailure 错误透传行为测试。
 *
 * 业务职责：
 * - 验证 handleRunFailure 对不同 error 类型的透传语义：
 *   1. 普通 Error（name 已被改写为 'ProviderError'）→ code 取自 error.name。
 *   2. 已有 TianjiError 实例 → 原样透传，category/code/message 均不变。
 *   3. 非 Error 值（字符串）→ code='unknown'、message=String(value)。
 * - 验证 failedRunSnapshot.metadata.failureCode 与透传后 code 一致。
 *
 * 对外触点：
 * - 直接调用 handleRunFailure，使用最小 fake 替代 snapshotStore / logger / engine。
 */
import {
  ProviderError,
  type RunFailedEvent,
  type RunSnapshot,
  TianjiError,
  createRunId,
  createSessionId,
} from '@tianji/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ReplayableEventStream } from '../event-stream.js'
import { handleRunFailure } from '../runtime/run-lifecycle.js'
import type {
  ActiveRun,
  RunExecutionContext,
  RunLifecycleDeps,
  RunLineageFields,
} from '../runtime/types.js'

// ── Fake 工厂 ─────────────────────────────────────────────────────────────────

function makeLineage(): RunLineageFields {
  return {
    sessionId: createSessionId('test-session'),
    runId: createRunId('test-run'),
    triggerType: 'user',
  }
}

function makeRunSnapshot(): RunSnapshot {
  const lineage = makeLineage()
  return {
    runId: lineage.runId,
    sessionId: lineage.sessionId,
    status: 'running',
    triggerType: 'user',
    messages: [],
    pendingOperations: [],
    metadata: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function makeContext(): RunExecutionContext {
  return {
    signal: new AbortController().signal,
    toolCatalog: {
      tools: [],
      getTool: () => undefined,
    } as unknown as RunExecutionContext['toolCatalog'],
    sequence: { current: 0 },
    pendingOperations: new Map(),
    destructiveOperationIds: new Set(),
  }
}

interface FakeSnapshotStore {
  savedRun: RunSnapshot | undefined
  saveRun: (snapshot: RunSnapshot) => Promise<void>
}

function makeDeps(): { deps: RunLifecycleDeps; store: FakeSnapshotStore } {
  const store: FakeSnapshotStore = {
    savedRun: undefined,
    saveRun: vi.fn(async (snapshot: RunSnapshot) => {
      store.savedRun = snapshot
    }),
  }

  const deps: RunLifecycleDeps = {
    snapshotStore: store as unknown as RunLifecycleDeps['snapshotStore'],
    logger: undefined,
    engine: 'deepagents',
  }

  return { deps, store }
}

function makeActiveRun(): { activeRun: ActiveRun; pushedEvents: unknown[] } {
  const pushedEvents: unknown[] = []
  const stream = new ReplayableEventStream()

  const activeRun: ActiveRun = {
    runId: makeLineage().runId,
    sessionId: makeLineage().sessionId,
    controller: new AbortController(),
    events: {
      push: (event: unknown) => {
        pushedEvents.push(event)
        stream.push(event as never)
      },
      close: () => stream.close(),
      fail: (err: Error) => stream.fail(err),
      [Symbol.asyncIterator]: stream[Symbol.asyncIterator].bind(stream),
    } as unknown as ActiveRun['events'],
  }

  return { activeRun, pushedEvents }
}

function findRunFailed(pushedEvents: unknown[]): RunFailedEvent {
  const event = pushedEvents.find(
    (e): e is RunFailedEvent =>
      typeof e === 'object' && e !== null && (e as RunFailedEvent).type === 'RunFailed'
  )
  if (event === undefined) {
    throw new Error('RunFailed event not found in pushedEvents')
  }
  return event
}

// ── 测试 ──────────────────────────────────────────────────────────────────────

describe('handleRunFailure — error 透传语义', () => {
  let lineage: RunLineageFields
  let runSnapshot: RunSnapshot
  let context: RunExecutionContext

  beforeEach(() => {
    lineage = makeLineage()
    runSnapshot = makeRunSnapshot()
    context = makeContext()
  })

  it('普通 Error（name 改写为 ProviderError）→ RunFailed.error.code 取自 error.name', async () => {
    const { deps, store } = makeDeps()
    const { activeRun, pushedEvents } = makeActiveRun()

    const err = new Error('500 empty_stream')
    err.name = 'ProviderError'

    await handleRunFailure(deps, activeRun, runSnapshot, context, lineage, err, undefined)

    const runFailed = findRunFailed(pushedEvents)
    expect(runFailed.error.code).toBe('ProviderError')
    expect(runFailed.error.message).toBe('500 empty_stream')
    expect(runFailed.error.category).toBe('internal')

    expect(store.savedRun?.metadata?.failureCode).toBe('ProviderError')
  })

  it('已有 TianjiError（ProviderError 实例）→ 原样透传，category/code/message 均不变', async () => {
    const { deps, store } = makeDeps()
    const { activeRun, pushedEvents } = makeActiveRun()

    const err = new ProviderError('PROVIDER_HTTP_500', 'upstream returned 500')

    await handleRunFailure(deps, activeRun, runSnapshot, context, lineage, err, undefined)

    const runFailed = findRunFailed(pushedEvents)
    expect(runFailed.error.code).toBe('PROVIDER_HTTP_500')
    expect(runFailed.error.message).toBe('upstream returned 500')
    expect(runFailed.error.category).toBe('provider')

    expect(store.savedRun?.metadata?.failureCode).toBe('PROVIDER_HTTP_500')
  })

  it('非 Error 值（字符串）→ code=unknown、message=String(value)', async () => {
    const { deps, store } = makeDeps()
    const { activeRun, pushedEvents } = makeActiveRun()

    await handleRunFailure(deps, activeRun, runSnapshot, context, lineage, 'boom', undefined)

    const runFailed = findRunFailed(pushedEvents)
    expect(runFailed.error.code).toBe('unknown')
    expect(runFailed.error.message).toBe('boom')
    expect(runFailed.error.category).toBe('internal')

    expect(store.savedRun?.metadata?.failureCode).toBe('unknown')
  })

  it('TianjiError 子类保持其原有 category（非 internal）', async () => {
    const { deps } = makeDeps()
    const { activeRun, pushedEvents } = makeActiveRun()

    const err = new TianjiError('tool', 'TOOL_TIMEOUT', 'tool timed out')

    await handleRunFailure(deps, activeRun, runSnapshot, context, lineage, err, undefined)

    const runFailed = findRunFailed(pushedEvents)
    expect(runFailed.error.category).toBe('tool')
    expect(runFailed.error.code).toBe('TOOL_TIMEOUT')
  })
})
