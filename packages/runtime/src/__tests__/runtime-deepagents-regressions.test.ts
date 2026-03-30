/**
 * deepagents runtime 回归测试。
 *
 * 业务职责：
 * - 覆盖富历史消息、外部 abort listener 清理、checkpoint 恢复约束与副作用恢复限制。
 * - 防止 deepagents 接入层在边界条件下回退到错误语义。
 *
 * 对外触点：
 * - 通过 createSessionRuntime 驱动 deepagents 运行时。
 * - 使用 InMemorySnapshotStore、ToolRegistry 与 helpers/runtime-test-utils 组合验证行为。
 */
import { getEventListeners } from 'node:events'

import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import {
  type RunSnapshot,
  type SessionSnapshot,
  createRunId,
  createSessionId,
} from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { createSessionRuntime } from '../runtime.js'
import { InMemorySnapshotStore } from '../snapshot-store.js'
import { ToolRegistry } from '../tool-catalog.js'
import {
  collectRuntimeEvents,
  createUserMessage,
  readTextContent,
  waitForRunStatus,
} from './helpers/runtime-test-utils.js'

describe('deepagents runtime regressions', () => {
  it('accepts image and tool-call parts in historical session messages', async () => {
    const runtime = createSessionRuntime({
      deepagents: {
        model: new FakeListChatModel({ responses: ['history preserved'] }),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry(),
    })
    const session = await runtime.createSession({
      sessionId: createSessionId('session-rich-history'),
      messages: [
        {
          id: 'msg-rich-history-1',
          role: 'user',
          content: [
            { type: 'text', text: 'Please inspect this image.' },
            { type: 'image', url: 'data:image/png;base64,AAAA' },
          ],
          createdAt: 1,
        },
        {
          id: 'msg-rich-history-2',
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'tool-history-1',
              toolName: 'lookup',
              args: { city: 'Shanghai' },
            },
          ],
          createdAt: 2,
        },
      ],
    })

    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-rich-history-3', 'continue from the earlier context'),
    })

    await collectRuntimeEvents(runId, runtime)
    await waitForRunStatus(runtime, runId, 'completed')

    const updatedSession = await runtime.getSessionSnapshot(session.sessionId)
    expect(readTextContent(updatedSession?.messages.at(-1))).toBe('history preserved')
  })

  it('cleans up reused external abort listeners after each completed run', async () => {
    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([{ name: 'sum', args: { a: 1, b: 2 }, id: 'call_sum_1' }])
          .respond(new AIMessage('sum 3'))
          .respondWithTools([{ name: 'sum', args: { a: 2, b: 3 }, id: 'call_sum_2' }])
          .respond(new AIMessage('sum 5'))
          .respondWithTools([{ name: 'sum', args: { a: 3, b: 4 }, id: 'call_sum_3' }])
          .respond(new AIMessage('sum 7')),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry().registerTool({
        spec: {
          name: 'sum',
          description: 'Add two numbers',
          parameters: {
            type: 'object',
            properties: {
              a: { type: 'number' },
              b: { type: 'number' },
            },
            required: ['a', 'b'],
          },
        },
        execute: async (args) => {
          if (!isRecord(args)) {
            throw new Error('Expected object args')
          }

          if (typeof args.a !== 'number' || typeof args.b !== 'number') {
            throw new Error('Expected numeric args')
          }

          return args.a + args.b
        },
        sideEffect: 'idempotent',
      }),
    })
    const externalController = new AbortController()
    const session = await runtime.createSession({
      sessionId: createSessionId('session-abort-listener-cleanup'),
    })

    for (const index of [1, 2, 3]) {
      const runId = await runtime.runTurn({
        sessionId: session.sessionId,
        message: createUserMessage(`msg-abort-cleanup-${index}`, `run ${index}`),
        abortSignal: externalController.signal,
      })

      await collectRuntimeEvents(runId, runtime)
      await waitForRunStatus(runtime, runId, 'completed')
      expect(getEventListeners(externalController.signal, 'abort')).toHaveLength(0)
    }
  })

  it('requires resumeValue for checkpointed deepagents runs', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const session: SessionSnapshot = {
      sessionId: createSessionId('session-checkpointed-resume'),
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        runtime: { engine: 'deepagents' },
      },
    }
    const checkpointedRun: RunSnapshot = {
      runId: createRunId('run-checkpointed-resume'),
      sessionId: session.sessionId,
      status: 'cancelled',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      pendingOperations: [],
      resumeHint: 'require-user-confirmation',
      metadata: {
        runtime: {
          engine: 'deepagents',
          threadId: session.sessionId,
          checkpointId: 'checkpoint-1',
        },
      },
    }

    await snapshotStore.saveSession(session)
    await snapshotStore.saveRun(checkpointedRun)

    const runtime = createSessionRuntime({
      deepagents: {
        model: 'openai:gpt-5.1',
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    await expect(runtime.resumeRun({ runId: checkpointedRun.runId })).rejects.toMatchObject({
      code: 'MISSING_RESUME_VALUE',
    })
  })

  it('rejects replay-style resume when a cancelled run already completed destructive work', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const session: SessionSnapshot = {
      sessionId: createSessionId('session-destructive-resume'),
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      metadata: {
        runtime: { engine: 'deepagents' },
      },
    }
    const runNeedingConfirmation: RunSnapshot = {
      runId: createRunId('run-destructive-resume'),
      sessionId: session.sessionId,
      status: 'cancelled',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      pendingOperations: [
        {
          id: 'tool-danger',
          invocation: {
            toolCallId: 'tool-danger',
            toolName: 'delete-file',
            args: { path: '/tmp/test.txt' },
          },
          status: 'completed',
          timestamp: 1,
        },
      ],
      resumeHint: 'require-user-confirmation',
      metadata: {
        runtime: {
          engine: 'deepagents',
          threadId: session.sessionId,
        },
      },
    }

    await snapshotStore.saveSession(session)
    await snapshotStore.saveRun(runNeedingConfirmation)

    const runtime = createSessionRuntime({
      deepagents: {
        model: 'openai:gpt-5.1',
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    await expect(runtime.resumeRun({ runId: runNeedingConfirmation.runId })).rejects.toMatchObject({
      code: 'UNSUPPORTED_DEEPAGENTS_RESUME',
    })
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
