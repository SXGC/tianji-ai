/**
 * fetch_url 工具单元测试。
 *
 * 业务职责:
 * - 验证参数解析、HTML→Markdown 转换、HTTP 失败、Markdown 截断、abortSignal 透传等核心行为。
 * - 通过 mock globalThis.fetch 隔离网络,保持测试可重复。
 */
import type { RuntimeToolExecutionContext } from '@tianji/runtime'
import { createRunId, createSessionId } from '@tianji/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFetchUrlTool } from '../../tools/fetch-url-tool.js'

const baseContext: RuntimeToolExecutionContext = {
  sessionId: createSessionId('sess_fetch_url_test'),
  runId: createRunId('run_fetch_url_test'),
  toolCallId: 'call_fetch_url_test',
}

/**
 * 创建一个带固定 final URL 的 mock Response,模拟 fetch 跟随重定向后的状态。
 * 直接 new Response 的 .url 只读为空串,所以用 defineProperty 注入。
 */
function createHtmlResponse(
  body: string,
  options: { status: number; finalUrl: string; statusText?: string }
): Response {
  const response = new Response(body, {
    status: options.status,
    statusText: options.statusText ?? (options.status === 200 ? 'OK' : ''),
    headers: { 'Content-Type': 'text/html' },
  })
  Object.defineProperty(response, 'url', { value: options.finalUrl })
  return response
}

describe('createFetchUrlTool', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('throws when args.url is missing', async () => {
    const tool = createFetchUrlTool()

    await expect(tool.execute({}, baseContext)).rejects.toThrow(
      /args\.url must be a non-empty string/
    )
  })

  it('returns markdown for a successful HTML response', async () => {
    const html = '<h1>Hello</h1><p>world</p>'
    globalThis.fetch = vi.fn(async () =>
      createHtmlResponse(html, {
        status: 200,
        finalUrl: 'https://example.com/page',
      })
    ) as unknown as typeof globalThis.fetch

    const tool = createFetchUrlTool()
    const raw = await tool.execute({ url: 'https://example.com/' }, baseContext)

    expect(raw).toMatchObject({
      url: expect.stringContaining('https://example.com'),
      statusCode: 200,
    })
    const result = raw as {
      readonly url: string
      readonly markdown: string
      readonly statusCode: number
      readonly contentLength: number
    }
    expect(result.markdown).toContain('Hello')
    expect(result.markdown).toContain('world')
    expect(result.contentLength).toBe(result.markdown.length)
  })

  it('throws when HTTP status is not ok', async () => {
    globalThis.fetch = vi.fn(async () =>
      createHtmlResponse('not found', {
        status: 404,
        statusText: 'Not Found',
        finalUrl: 'https://example.com/missing',
      })
    ) as unknown as typeof globalThis.fetch

    const tool = createFetchUrlTool()
    await expect(tool.execute({ url: 'https://example.com/missing' }, baseContext)).rejects.toThrow(
      /HTTP 404 Not Found/
    )
  })

  it('truncates markdown to maxMarkdownLength', async () => {
    const longHtml = `<p>${'x'.repeat(50_000)}</p>`
    globalThis.fetch = vi.fn(async () =>
      createHtmlResponse(longHtml, {
        status: 200,
        finalUrl: 'https://example.com/long',
      })
    ) as unknown as typeof globalThis.fetch

    const tool = createFetchUrlTool({ maxMarkdownLength: 100 })
    const result = (await tool.execute({ url: 'https://example.com/long' }, baseContext)) as {
      markdown: string
      contentLength: number
    }

    expect(result.markdown.length).toBe(100)
    expect(result.contentLength).toBe(100)
  })

  it('aborts the underlying fetch when context.abortSignal fires', async () => {
    let receivedSignal: AbortSignal | undefined
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = init?.signal ?? undefined
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'))
          })
        })
    ) as unknown as typeof globalThis.fetch

    const tool = createFetchUrlTool()
    const runtimeController = new AbortController()
    const promise = tool.execute(
      { url: 'https://example.com/slow' },
      { ...baseContext, abortSignal: runtimeController.signal }
    )

    runtimeController.abort()
    await expect(promise).rejects.toThrow(/abort/i)
    expect(receivedSignal).toBeDefined()
    expect(receivedSignal?.aborted).toBe(true)
  })

  it('aborts the underlying fetch when timeoutMs elapses', async () => {
    let receivedSignal: AbortSignal | undefined
    globalThis.fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          receivedSignal = init?.signal ?? undefined
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'))
          })
        })
    ) as unknown as typeof globalThis.fetch

    const tool = createFetchUrlTool()
    await expect(
      tool.execute({ url: 'https://example.com/slow', timeoutMs: 25 }, baseContext)
    ).rejects.toThrow(/abort/i)
    expect(receivedSignal?.aborted).toBe(true)
  })

  it('throws when args.timeoutMs is not a positive finite number', async () => {
    const tool = createFetchUrlTool()

    await expect(
      tool.execute({ url: 'https://example.com/', timeoutMs: -1 }, baseContext)
    ).rejects.toThrow(/timeoutMs must be a positive finite number/)
    await expect(
      tool.execute({ url: 'https://example.com/', timeoutMs: 'soon' }, baseContext)
    ).rejects.toThrow(/timeoutMs must be a positive finite number/)
  })
})
