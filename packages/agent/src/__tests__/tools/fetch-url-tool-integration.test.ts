/**
 * fetch_url 工具集成测试。
 *
 * 业务职责:
 * - 验证把 fetch_url 注册到 ToolRegistry 后,通过 SessionRuntime 触发的工具调用能进入完整治理路径:
 *   - 出现 tool.started / tool.completed 事件
 *   - tool.completed.result 中包含 markdown 字段
 * - 用 fakeModel 模拟 LLM 返回工具调用,用 mock fetch 隔离网络。
 *
 * 对外触点:
 * - 通过 @tianji/runtime 的 createSessionRuntime 直接组装,验证 ToolCatalog → deepagents 适配链路。
 */
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { InMemorySnapshotStore, ToolRegistry, createSessionRuntime } from '@tianji/runtime'
import { type DomainEvent, createSessionId } from '@tianji/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFetchUrlTool } from '../../tools/fetch-url-tool.js'

/**
 * 收集 runtime 事件流为数组,即使中途抛出 ProviderError 也保留已收到的事件。
 * 工具失败场景下,runtime 会在 tool.failed/run.failed 之后让 stream throw,
 * 测试需要捕获以便对失败前的事件做断言。
 */
async function collectEvents(iter: AsyncIterable<DomainEvent>): Promise<DomainEvent[]> {
  const events: DomainEvent[] = []
  try {
    for await (const event of iter) {
      events.push(event)
    }
  } catch {
    // 失败语义下的事件已经收集完毕,直接返回
  }
  return events
}

describe('fetch_url tool integration with SessionRuntime', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('emits tool.started and tool.completed when LLM invokes fetch_url', async () => {
    const html = '<h1>Tianji</h1><p>Hello world</p>'
    globalThis.fetch = vi.fn(async () => {
      const response = new Response(html, {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'text/html' },
      })
      Object.defineProperty(response, 'url', {
        value: 'https://example.com/welcome',
      })
      return response
    }) as unknown as typeof globalThis.fetch

    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([
            {
              name: 'fetch_url',
              args: { url: 'https://example.com/welcome' },
              id: 'call_fetch_url',
            },
          ])
          .respond(new AIMessage('Fetched successfully')),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry().registerTool(createFetchUrlTool()),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-fetch-url-integration'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: {
        id: 'msg-fetch-url-integration',
        role: 'user',
        content: [{ type: 'text', text: 'fetch the welcome page' }],
        createdAt: 1,
      },
    })

    const events = await collectEvents(runtime.streamEvents(runId))

    const toolStarted = events.find(
      (e): e is Extract<DomainEvent, { type: 'ToolStarted' }> =>
        e.type === 'ToolStarted' && e.invocation.toolName === 'fetch_url'
    )
    const toolCompleted = events.find(
      (e): e is Extract<DomainEvent, { type: 'ToolCompleted' }> =>
        e.type === 'ToolCompleted' && e.toolCallId === 'call_fetch_url'
    )

    expect(toolStarted).toBeDefined()
    expect(toolStarted?.invocation.args).toMatchObject({
      url: 'https://example.com/welcome',
    })

    expect(toolCompleted).toBeDefined()
    const completedResult = toolCompleted?.result.result as {
      readonly url: string
      readonly markdown: string
      readonly statusCode: number
      readonly contentLength: number
    }
    expect(completedResult.statusCode).toBe(200)
    expect(completedResult.markdown).toContain('Tianji')
    expect(completedResult.markdown).toContain('Hello world')
  })

  it('emits tool.failed when fetch_url throws on HTTP error', async () => {
    globalThis.fetch = vi.fn(async () => {
      const response = new Response('boom', {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'Content-Type': 'text/html' },
      })
      Object.defineProperty(response, 'url', {
        value: 'https://example.com/broken',
      })
      return response
    }) as unknown as typeof globalThis.fetch

    const runtime = createSessionRuntime({
      deepagents: {
        model: fakeModel()
          .respondWithTools([
            {
              name: 'fetch_url',
              args: { url: 'https://example.com/broken' },
              id: 'call_fetch_url_fail',
            },
          ])
          .respond(new AIMessage('Recovered')),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry().registerTool(createFetchUrlTool()),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('session-fetch-url-integration-fail'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: {
        id: 'msg-fetch-url-integration-fail',
        role: 'user',
        content: [{ type: 'text', text: 'fetch the broken page' }],
        createdAt: 1,
      },
    })
    const events = await collectEvents(runtime.streamEvents(runId))
    const toolFailed = events.find(
      (e): e is Extract<DomainEvent, { type: 'ToolFailed' }> =>
        e.type === 'ToolFailed' && e.invocation.toolName === 'fetch_url'
    )
    expect(toolFailed).toBeDefined()
    expect(toolFailed?.error.message).toMatch(/HTTP 500/)
  })
})
