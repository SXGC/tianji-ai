/**
 * SessionRuntime 生命周期测试。
 *
 * 业务职责：
 * - 验证关闭会话时会写入 closedAt、终止活跃运行并阻止后续 runTurn/resumeRun。
 * - 覆盖运行时在会话关闭场景下的资源释放与状态持久化行为。
 *
 * 对外触点：
 * - 通过 createSessionRuntime 驱动真实运行时生命周期。
 * - 使用 helpers/runtime-test-utils 聚合事件与轮询运行状态。
 */
import { fakeModel } from '@langchain/core/testing'
import { createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createSessionRuntime } from '../runtime.js'
import { InMemorySnapshotStore } from '../snapshot-store.js'
import { ToolRegistry } from '../tool-catalog.js'
import {
  collectRuntimeEvents,
  createAbortError,
  createDeferred,
  createUserMessage,
  waitForRunStatus,
} from './helpers/runtime-test-utils.js'

describe('SessionRuntime lifecycle', () => {
  it('closes sessions by persisting closedAt, aborting active runs, and blocking future work', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'lookup', args: { city: 'Shanghai' }, id: 'tool-close' },
        ]),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry().registerTool({
        spec: {
          name: 'lookup',
          description: 'Look up data',
          parameters: { type: 'object' },
        },
        execute: async (_args, context) => {
          toolSignalSeen.resolve(context.abortSignal)

          await new Promise<never>((_resolve, reject) => {
            context.abortSignal?.addEventListener(
              'abort',
              () => {
                reject(createAbortError('session closed'))
              },
              { once: true }
            )
          })

          throw new Error('Unreachable')
        },
        sideEffect: 'idempotent',
      }),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-close'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-close-user', 'close this session'),
    })
    const eventsPromise = collectRuntimeEvents(runId, runtime)
    const activeToolSignal = await toolSignalSeen.promise

    const closedSession = await runtime.closeSession(session.sessionId)
    const events = await eventsPromise
    const cancelledRun = await waitForRunStatus(runtime, runId, 'cancelled')

    expect(closedSession.metadata?.closedAt).toEqual(expect.any(Number))
    expect(activeToolSignal?.aborted).toBe(true)
    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.started',
      'tool.started',
      'run.cancelled',
    ])
    expect(cancelledRun.status).toBe('cancelled')
    await expect(
      runtime.runTurn({
        sessionId: session.sessionId,
        message: createUserMessage('msg-close-next', 'try again'),
      })
    ).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
    await expect(runtime.resumeRun({ runId })).rejects.toMatchObject({ code: 'SESSION_CLOSED' })
  })
})
