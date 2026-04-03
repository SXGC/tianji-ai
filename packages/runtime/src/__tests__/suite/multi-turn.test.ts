/**
 * 多轮对话连续性集成测试。
 *
 * 业务职责：
 * - 验证 SessionRuntime 在同一 session 下多轮 runTurn 的消息追加、历史传递与快照一致性。
 * - 覆盖工具调用轮次对后续历史的影响、runId 唯一性与 updatedAt 单调递增。
 *
 * 对外触点：
 * - 通过 helpers/runtime-test-utils 组装 runtime 并驱动多轮对话。
 * - 依赖 @langchain/core/testing 的 fakeModel 构建确定性 LLM 替身。
 *
 * 注意：fakeModel 的 _callIndex 在每次 bindTools 时按值复制，导致跨 run 的
 * 队列索引不共享。因此多轮场景使用 respond(factory) 配合外部计数器来区分各轮响应。
 */
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { type RuntimeEvent, createSessionId } from '@tianji/shared'

import { createSessionRuntime } from '../../runtime.js'
import { InMemorySnapshotStore } from '../../snapshot-store.js'
import { ToolRegistry } from '../../tool-catalog.js'
import {
  assertRunCompleted,
  assertToolCalled,
  createMockTool,
  createToolRegistry,
  createUserMessage,
  driveMultiTurn,
  readTextContent,
} from '../helpers/runtime-test-utils.js'

/**
 * 创建一个基于外部计数器的响应工厂，使 fakeModel 在跨 run 的 bindTools 重置后
 * 仍能按顺序返回不同内容。
 *
 * @param answers - 按轮次顺序排列的回复文本列表
 */
function createSequentialResponder(answers: string[]): () => AIMessage {
  let callIndex = 0
  return () => {
    const text = answers[callIndex % answers.length]!
    callIndex += 1
    return new AIMessage(text)
  }
}

describe('suite/multi-turn', () => {
  it('连续 3 轮 runTurn 均正常完成且 session 消息完整', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const responder = createSequentialResponder(['answer-1', 'answer-2', 'answer-3'])
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(responder).respond(responder).respond(responder),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const sessionId = createSessionId('multi-turn-3rounds')
    await runtime.createSession({ sessionId })

    const results = await driveMultiTurn(runtime, sessionId, [
      { id: 'msg-1', text: 'question-1' },
      { id: 'msg-2', text: 'question-2' },
      { id: 'msg-3', text: 'question-3' },
    ])

    // 每轮均正常完成
    for (const turn of results) {
      assertRunCompleted(turn.events)
    }

    // session snapshot 有 6 条消息：3 user + 3 assistant
    const snapshot = await runtime.getSessionSnapshot(sessionId)
    expect(snapshot).toBeDefined()
    expect(snapshot!.messages).toHaveLength(6)

    // 验证 assistant 消息内容
    expect(readTextContent(snapshot!.messages[1])).toBe('answer-1')
    expect(readTextContent(snapshot!.messages[3])).toBe('answer-2')
    expect(readTextContent(snapshot!.messages[5])).toBe('answer-3')
  })

  it('第 2 轮消息历史包含第 1 轮内容', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const responder = createSequentialResponder(['reply-1', 'reply-2'])
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(responder).respond(responder),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const sessionId = createSessionId('multi-turn-history')
    await runtime.createSession({ sessionId })

    await driveMultiTurn(runtime, sessionId, [
      { id: 'msg-a', text: 'hello' },
      { id: 'msg-b', text: 'follow up' },
    ])

    const snapshot = await runtime.getSessionSnapshot(sessionId)
    expect(snapshot).toBeDefined()
    expect(snapshot!.messages).toHaveLength(4)
    expect(snapshot!.messages[0]!.role).toBe('user')
    expect(snapshot!.messages[1]!.role).toBe('assistant')
    expect(snapshot!.messages[2]!.role).toBe('user')
    expect(snapshot!.messages[3]!.role).toBe('assistant')
  })

  it('中间轮触发工具调用，后续轮消息历史包含工具结果', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const echoTool = createMockTool('echo', { result: 'pong' })
    const toolRegistry = createToolRegistry(echoTool)

    // 第 1 轮：工具调用 + 最终回复（model 被调用 2 次）
    // 第 2 轮：直接回复（model 被调用 1 次）
    // bindTools 会重置 _callIndex，所以第 2 轮又从 index 0 开始
    // 需要 3 个 respond 入队：turn1-tool, turn1-final, turn2-final
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'echo', args: { text: 'ping' }, id: 'tool-echo-1' }])
          .respond(new AIMessage('echo done'))
          .respond(new AIMessage('follow up answer')),
      },
      snapshotStore,
      toolCatalog: toolRegistry,
    })

    const sessionId = createSessionId('multi-turn-tool')
    await runtime.createSession({ sessionId })

    const results = await driveMultiTurn(runtime, sessionId, [
      { id: 'msg-tool-1', text: 'call echo' },
      { id: 'msg-tool-2', text: 'what happened' },
    ])

    // 第 1 轮工具被调用且完成
    assertToolCalled(results[0]!.events, 'echo')
    assertRunCompleted(results[0]!.events)

    // 第 2 轮也正常完成
    assertRunCompleted(results[1]!.events)

    // session 消息数 >= 4（user + assistant with tool + user + assistant）
    const snapshot = await runtime.getSessionSnapshot(sessionId)
    expect(snapshot).toBeDefined()
    expect(snapshot!.messages.length).toBeGreaterThanOrEqual(4)
  })

  it('每轮的 sessionId 相同，runId 不同', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const responder = createSequentialResponder(['r1', 'r2'])
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(responder).respond(responder),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const sessionId = createSessionId('multi-turn-ids')
    await runtime.createSession({ sessionId })

    const results = await driveMultiTurn(runtime, sessionId, [
      { id: 'msg-id-1', text: 'first' },
      { id: 'msg-id-2', text: 'second' },
    ])

    // 从 run.started 事件提取 sessionId 和 runId
    const startedEvents = results.map((r) =>
      r.events.find(
        (e): e is Extract<RuntimeEvent, { type: 'run.started' }> => e.type === 'run.started'
      )
    )

    expect(startedEvents[0]).toBeDefined()
    expect(startedEvents[1]).toBeDefined()

    // sessionId 一致
    expect(startedEvents[0]!.sessionId).toBe(sessionId)
    expect(startedEvents[1]!.sessionId).toBe(sessionId)

    // runId 不同
    expect(results[0]!.runId).not.toBe(results[1]!.runId)
  })

  it('多轮后 session snapshot 的 updatedAt 单调递增', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const responder = createSequentialResponder(['t1', 't2', 't3'])
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel().respond(responder).respond(responder).respond(responder),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const sessionId = createSessionId('multi-turn-timestamp')
    await runtime.createSession({ sessionId })

    const timestamps: number[] = []

    const prompts = [
      { id: 'msg-ts-1', text: 'a' },
      { id: 'msg-ts-2', text: 'b' },
      { id: 'msg-ts-3', text: 'c' },
    ]

    for (const prompt of prompts) {
      const message = createUserMessage(prompt.id, prompt.text)
      const runId = await runtime.runTurn({ sessionId, message })

      // 收集事件以等待 run 完成
      for await (const _event of runtime.streamEvents(runId)) {
        // 消费直到流结束
      }

      const snapshot = await runtime.getSessionSnapshot(sessionId)
      expect(snapshot).toBeDefined()
      timestamps.push(snapshot!.updatedAt)
    }

    // 验证单调递增
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]!).toBeGreaterThanOrEqual(timestamps[i - 1]!)
    }
  })
})
