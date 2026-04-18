import type { StateSnapshot } from '@langchain/langgraph'

import { AIMessage } from '@langchain/core/messages'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { TianjiError } from '@tianji/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { createDeepAgentMock, clientConstructorMock, tracerConstructorMock } = vi.hoisted(() => ({
  createDeepAgentMock: vi.fn(),
  clientConstructorMock: vi.fn(),
  tracerConstructorMock: vi.fn(),
}))

vi.mock('deepagents', () => ({
  createDeepAgent: createDeepAgentMock,
}))

vi.mock('langsmith', () => ({
  Client: class MockClient {
    constructor(config: unknown) {
      clientConstructorMock(config)
    }
  },
}))

vi.mock('@langchain/core/tracers/tracer_langchain', () => ({
  LangChainTracer: class MockLangChainTracer {
    readonly fields: unknown

    constructor(fields: unknown) {
      this.fields = fields
      tracerConstructorMock(fields)
    }
  },
}))

import { createSessionRuntime } from '../runtime.js'
import { InMemorySnapshotStore } from '../snapshot-store.js'
import { ToolRegistry } from '../tool-catalog.js'
import { createUserMessage } from './helpers/runtime-test-utils.js'

function createChatModelEndAsyncIterable(): AsyncIterable<{
  readonly event: string
  readonly name: string
  readonly run_id: string
  readonly data: Record<string, unknown>
}> {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        event: 'on_chat_model_stream',
        name: 'ChatOpenAI',
        run_id: 'chat-model-stream',
        data: {
          chunk: {
            content: 'done',
          },
        },
      }
      yield {
        event: 'on_chat_model_end',
        name: 'ChatOpenAI',
        run_id: 'chat-model-end',
        data: {
          output: new AIMessage('done'),
        },
      }
    },
  }
}

function createStateSnapshot(): StateSnapshot {
  return {
    values: {},
    next: [],
    tasks: [],
    metadata: undefined,
    config: {
      configurable: {
        thread_id: 'session-langsmith',
      },
    },
    createdAt: undefined,
    parentConfig: undefined,
  }
}

describe('runtime langsmith tracing', () => {
  afterEach(() => {
    createDeepAgentMock.mockReset()
    clientConstructorMock.mockReset()
    tracerConstructorMock.mockReset()
  })

  it('fails fast when langsmith tracing is enabled without project', () => {
    expect(() =>
      createSessionRuntime({
        deepagents: {
          model: new FakeListChatModel({ responses: ['ok'] }),
        },
        tracing: {
          langsmith: {
            enabled: true,
            apiKey: 'ls-key',
          },
        },
        snapshotStore: new InMemorySnapshotStore(),
        toolCatalog: new ToolRegistry(),
      })
    ).toThrow(TianjiError)
  })

  it('creates a LangChainTracer and passes callbacks metadata tags to deepagents', async () => {
    const streamEventsMock = vi.fn(async () => createChatModelEndAsyncIterable())

    createDeepAgentMock.mockReturnValue({
      streamEvents: streamEventsMock,
      getState: vi.fn(async () => createStateSnapshot()),
    })

    const runtime = createSessionRuntime({
      deepagents: {
        model: new FakeListChatModel({ responses: ['done'] }),
      },
      tracing: {
        langsmith: {
          enabled: true,
          project: 'runtime-project',
          apiKey: 'ls-key',
          apiUrl: 'https://api.smith.langchain.com',
          tags: ['configured'],
          metadata: {
            service: 'tianji-runtime',
          },
        },
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: 'session-langsmith' as never,
    })

    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-langsmith', 'trace this'),
    })

    for await (const _event of runtime.streamEvents(runId)) {
      // consume to completion
    }

    expect(clientConstructorMock).toHaveBeenCalledWith({
      apiKey: 'ls-key',
      apiUrl: 'https://api.smith.langchain.com',
    })
    expect(tracerConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'runtime-project',
        client: expect.anything(),
      })
    )
    expect(streamEventsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        version: 'v2',
        callbacks: [expect.anything()],
        tags: ['configured', 'tianji', 'runtime', 'trigger:new'],
        metadata: expect.objectContaining({
          service: 'tianji-runtime',
          sessionId: 'session-langsmith',
          runId,
          triggerType: 'new',
        }),
        configurable: {
          thread_id: 'session-langsmith',
          checkpoint_id: undefined,
        },
      })
    )
  })
})
