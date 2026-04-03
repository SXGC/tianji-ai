/**
 * 并发安全集成测试。
 *
 * 业务职责：
 * - 验证不同 session 同时 runTurn 各自独立完成。
 * - 验证并发 run 的 session snapshot 互不干扰。
 * - 验证一个 session 的 run 失败不影响另一个。
 * - 验证取消一个 session 的 run 不影响另一个。
 *
 * 对外触点：
 * - 通过 createSessionRuntime + fakeModel 构建确定性 LLM 替身。
 * - 依赖 helpers/runtime-test-utils 完成事件收集与断言。
 */
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { createSessionId } from '@tianji/shared'

import { createSessionRuntime } from '../../runtime.js'
import { InMemorySnapshotStore } from '../../snapshot-store.js'
import { ToolRegistry } from '../../tool-catalog.js'
import {
  assertRunCompleted,
  collectRuntimeEvents,
  collectRuntimeOutcome,
  createAbortError,
  createDeferred,
  createMockTool,
  createToolRegistry,
  createUserMessage,
  readTextContent,
} from '../helpers/runtime-test-utils.js'

describe('suite/concurrency', () => {
  it('两个不同 session 同时 runTurn，各自 run.completed', async () => {
    const snapshotStore = new InMemorySnapshotStore()

    const runtimeA = createSessionRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('reply-a')) },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })
    const runtimeB = createSessionRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('reply-b')) },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const sessionA = createSessionId('conc-dual-a')
    const sessionB = createSessionId('conc-dual-b')
    await runtimeA.createSession({ sessionId: sessionA })
    await runtimeB.createSession({ sessionId: sessionB })

    const runIdA = await runtimeA.runTurn({
      sessionId: sessionA,
      message: createUserMessage('msg-a', 'hello a'),
    })
    const runIdB = await runtimeB.runTurn({
      sessionId: sessionB,
      message: createUserMessage('msg-b', 'hello b'),
    })

    const [eventsA, eventsB] = await Promise.all([
      collectRuntimeEvents(runIdA, runtimeA),
      collectRuntimeEvents(runIdB, runtimeB),
    ])

    assertRunCompleted(eventsA)
    assertRunCompleted(eventsB)

    // 验证事件中 sessionId 严格对应
    for (const event of eventsA) {
      if ('sessionId' in event) {
        expect(event.sessionId).toBe(sessionA)
      }
    }
    for (const event of eventsB) {
      if ('sessionId' in event) {
        expect(event.sessionId).toBe(sessionB)
      }
    }
  })

  it('并发 run 各自的 session snapshot 独立更新', async () => {
    const snapshotStore = new InMemorySnapshotStore()

    const runtimeA = createSessionRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('answer-alpha')) },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })
    const runtimeB = createSessionRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('answer-beta')) },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const sessionA = createSessionId('conc-snap-a')
    const sessionB = createSessionId('conc-snap-b')
    await runtimeA.createSession({ sessionId: sessionA })
    await runtimeB.createSession({ sessionId: sessionB })

    const runIdA = await runtimeA.runTurn({
      sessionId: sessionA,
      message: createUserMessage('msg-snap-a', 'question alpha'),
    })
    const runIdB = await runtimeB.runTurn({
      sessionId: sessionB,
      message: createUserMessage('msg-snap-b', 'question beta'),
    })

    await Promise.all([
      collectRuntimeEvents(runIdA, runtimeA),
      collectRuntimeEvents(runIdB, runtimeB),
    ])

    const snapA = await runtimeA.getSessionSnapshot(sessionA)
    const snapB = await runtimeB.getSessionSnapshot(sessionB)

    expect(snapA).toBeDefined()
    expect(snapB).toBeDefined()

    // A 的消息不包含 B 的内容，反之亦然
    const textsA = snapA!.messages.map((m) => readTextContent(m)).join(' ')
    const textsB = snapB!.messages.map((m) => readTextContent(m)).join(' ')

    expect(textsA).not.toContain('beta')
    expect(textsA).not.toContain('question beta')
    expect(textsB).not.toContain('alpha')
    expect(textsB).not.toContain('question alpha')
  })

  it('一个 session 的 run 失败不影响另一个', async () => {
    const snapshotStore = new InMemorySnapshotStore()

    const bombTool = createMockTool('bomb', { error: new Error('boom') })
    const runtimeA = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([{ name: 'bomb', args: {}, id: 'tc-bomb' }]),
      },
      snapshotStore,
      toolCatalog: createToolRegistry(bombTool),
    })
    const runtimeB = createSessionRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('ok-b')) },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const sessionA = createSessionId('conc-fail-a')
    const sessionB = createSessionId('conc-fail-b')
    await runtimeA.createSession({ sessionId: sessionA })
    await runtimeB.createSession({ sessionId: sessionB })

    const runIdA = await runtimeA.runTurn({
      sessionId: sessionA,
      message: createUserMessage('msg-fail-a', 'explode'),
    })
    const runIdB = await runtimeB.runTurn({
      sessionId: sessionB,
      message: createUserMessage('msg-fail-b', 'be fine'),
    })

    const [outcomeA, eventsB] = await Promise.all([
      collectRuntimeOutcome(runIdA, runtimeA),
      collectRuntimeEvents(runIdB, runtimeB),
    ])

    // A 有 error
    expect(outcomeA.error).toBeDefined()

    // B 正常完成
    assertRunCompleted(eventsB)
  })

  it('取消一个 session 的 run 不影响另一个', async () => {
    const snapshotStore = new InMemorySnapshotStore()

    // runtime A：取消模式工具
    const toolSignalSeen = createDeferred<AbortSignal | undefined>()
    const blockRegistry = new ToolRegistry().registerTool({
      spec: { name: 'block', description: 'Block', parameters: { type: 'object' } },
      execute: async (_args, context) => {
        toolSignalSeen.resolve(context.abortSignal)
        await new Promise<never>((_resolve, reject) => {
          context.abortSignal?.addEventListener(
            'abort',
            () => {
              reject(createAbortError('cancelled'))
            },
            { once: true }
          )
        })
        throw new Error('Unreachable')
      },
      sideEffect: 'idempotent',
    })

    const runtimeA = createSessionRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([{ name: 'block', args: {}, id: 'tc-block' }]),
      },
      snapshotStore,
      toolCatalog: blockRegistry,
    })
    const runtimeB = createSessionRuntime({
      deepagents: { model: fakeModel().respond(new AIMessage('ok-cancel-b')) },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const sessionA = createSessionId('conc-cancel-a')
    const sessionB = createSessionId('conc-cancel-b')
    await runtimeA.createSession({ sessionId: sessionA })
    await runtimeB.createSession({ sessionId: sessionB })

    // A 先 runTurn，等工具信号
    const runIdA = await runtimeA.runTurn({
      sessionId: sessionA,
      message: createUserMessage('msg-cancel-a', 'block'),
    })
    const eventsPromiseA = collectRuntimeOutcome(runIdA, runtimeA)
    await toolSignalSeen.promise

    // B runTurn
    const runIdB = await runtimeB.runTurn({
      sessionId: sessionB,
      message: createUserMessage('msg-cancel-b', 'proceed'),
    })

    // 取消 A
    runtimeA.cancelRun(runIdA)

    const [outcomeA, eventsB] = await Promise.all([
      eventsPromiseA,
      collectRuntimeEvents(runIdB, runtimeB),
    ])

    // A 有 run.cancelled
    const typesA = outcomeA.events.map((e) => e.type)
    expect(typesA).toContain('run.cancelled')

    // B 正常完成
    assertRunCompleted(eventsB)
  })
})
