/**
 * deepagents runtime 启动配置测试。
 *
 * 业务职责：
 * - 校验 runtime 以 deepagents 配置启动时能够正常执行并记录 thread 元数据。
 * - 验证缺失 deepagents.model 时会快速失败并返回稳定错误码。
 *
 * 对外触点：
 * - 调用 createSessionRuntime 初始化 deepagents 运行时。
 * - 通过 helpers/runtime-test-utils 读取事件流与最终消息。
 */
import type { SessionRuntimeDeepagentsConfig } from '../runtime.js'

import { FakeListChatModel } from '@langchain/core/utils/testing'
import { TianjiError, createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createSessionRuntime, readRunRuntimeMetadata } from '../runtime.js'
import { InMemorySnapshotStore } from '../snapshot-store.js'
import { ToolRegistry } from '../tool-catalog.js'
import {
  collectRuntimeEvents,
  createTestRuntime,
  createUserMessage,
  readTextContent,
  waitForRunStatus,
} from './helpers/runtime-test-utils.js'

describe('deepagents runtime bootstrap', () => {
  it('boots from deepagents config and records thread metadata', async () => {
    const runtime = createTestRuntime({
      engine: 'deepagents',
      deepagents: {
        model: new FakeListChatModel({ responses: ['hello from deepagents'] }),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry(),
    })
    const session = await runtime.createSession({
      sessionId: createSessionId('session-deepagents-bootstrap'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-deepagents-bootstrap', 'say hello'),
    })
    const events = await collectRuntimeEvents(runId, runtime)
    const completedRun = await waitForRunStatus(runtime, runId, 'completed')
    const sessionSnapshot = await runtime.getSessionSnapshot(session.sessionId)
    const completedMessage = events.find(
      (event): event is Extract<(typeof events)[number], { type: 'message.completed' }> =>
        event.type === 'message.completed'
    )

    expect(events[0]?.type).toBe('run.started')
    expect(events[1]?.type).toBe('message.started')
    expect(events.some((event) => event.type === 'message.delta')).toBe(true)
    expect(events.some((event) => event.type === 'message.completed')).toBe(true)
    expect(events.at(-1)?.type).toBe('run.completed')
    expect(readTextContent(completedMessage?.message)).toBe('hello from deepagents')
    expect(readTextContent(sessionSnapshot?.messages.at(-1))).toBe('hello from deepagents')
    expect(readRunRuntimeMetadata(completedRun.metadata)).toEqual({
      engine: 'deepagents',
      threadId: session.sessionId,
      checkpointId: undefined,
    })
  })

  it('fails fast when model is missing', () => {
    expect.assertions(4)
    const deepagents = {} as SessionRuntimeDeepagentsConfig

    expect(() =>
      createSessionRuntime({
        engine: 'deepagents',
        deepagents,
        snapshotStore: new InMemorySnapshotStore(),
        toolCatalog: new ToolRegistry(),
      })
    ).toThrow(TianjiError)

    try {
      createSessionRuntime({
        engine: 'deepagents',
        deepagents,
        snapshotStore: new InMemorySnapshotStore(),
        toolCatalog: new ToolRegistry(),
      })
    } catch (error) {
      expect(error).toBeInstanceOf(TianjiError)
      expect((error as TianjiError).code).toBe('INVALID_DEEPAGENTS_CONFIG')
      expect((error as TianjiError).message).toContain('deepagents.model')
    }
  })
})
