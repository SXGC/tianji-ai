/**
 * fetch_url 工具:抓取 HTTP/HTTPS URL 并把响应 HTML 转换为 Markdown。
 *
 * 业务职责:
 * - 给 LLM 提供读取公开网页正文的能力,自动跟随重定向。
 * - 通过 runtime ToolCatalog 注册,自动获得策略门、超时控制、abortSignal 转发与 tool.* 事件流。
 *
 * 对外触点:
 * - 由 createAgentRuntime 在组装 SessionRuntime 时注入到 ToolRegistry。
 * - 直接消费全局 fetch + turndown,不持有任何外部状态。
 */
import TurndownService from 'turndown'

import type { RuntimeToolDefinition } from '@tianji/runtime'

/** fetch_url 工具的构造选项。 */
export interface FetchUrlToolOptions {
  /** 默认请求超时,毫秒。可被 args.timeoutMs 覆盖。默认 30000。 */
  readonly defaultTimeoutMs?: number
  /** Markdown 最大长度,超出截断,防止上下文撑爆。默认 20000。 */
  readonly maxMarkdownLength?: number
}

/** fetch_url 工具的返回结构。 */
export interface FetchUrlResult {
  readonly url: string
  readonly markdown: string
  readonly statusCode: number
  readonly contentLength: number
}

const DEFAULT_MAX_MARKDOWN_LENGTH = 20_000
const DEFAULT_TIMEOUT_MS = 30_000

interface FetchUrlArgs {
  readonly url: string
  readonly timeoutMs?: number
}

/**
 * 把 unknown 形态的工具调用参数解析为 FetchUrlArgs。
 * 类型不符立即抛错,由 runtime 适配层包装为 ToolError。
 */
function parseFetchUrlArgs(args: unknown): FetchUrlArgs {
  if (typeof args !== 'object' || args === null) {
    throw new Error('fetch_url args must be an object')
  }
  const candidate = args as { url?: unknown; timeoutMs?: unknown }
  if (typeof candidate.url !== 'string' || candidate.url.length === 0) {
    throw new Error('fetch_url args.url must be a non-empty string')
  }
  if (
    candidate.timeoutMs !== undefined &&
    (typeof candidate.timeoutMs !== 'number' ||
      !Number.isFinite(candidate.timeoutMs) ||
      candidate.timeoutMs <= 0)
  ) {
    throw new Error('fetch_url args.timeoutMs must be a positive finite number')
  }
  return {
    url: candidate.url,
    timeoutMs: candidate.timeoutMs as number | undefined,
  }
}

/**
 * 构造 fetch_url 工具定义,可注册到 runtime ToolRegistry。
 *
 * 抓取 HTTP/HTTPS URL,自动跟随重定向,把 HTML 转换为 Markdown 后返回。
 * 通过 ToolCatalog 路径接入,自动获得 runtime 的策略门、超时控制、HITL pending 与 tool.* 事件流。
 */
export function createFetchUrlTool(options: FetchUrlToolOptions = {}): RuntimeToolDefinition {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxMarkdownLength = options.maxMarkdownLength ?? DEFAULT_MAX_MARKDOWN_LENGTH
  const turndown = new TurndownService()

  return {
    spec: {
      name: 'fetch_url',
      description:
        '抓取 HTTP/HTTPS URL 内容,自动跟随重定向,返回页面正文的 Markdown 文本。仅用于读取公开网页。',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要抓取的 HTTP 或 HTTPS URL',
          },
          timeoutMs: {
            type: 'number',
            description: '请求超时毫秒,可选,默认 30000',
          },
        },
        required: ['url'],
      },
    },
    sideEffect: 'idempotent',
    execute: async (args, context): Promise<FetchUrlResult> => {
      const { url, timeoutMs } = parseFetchUrlArgs(args)

      // 把 runtime 上层的 abortSignal 转发到内部 controller,任何一边触发都会终止 fetch。
      // 同时设置一个 setTimeout,在超过 timeoutMs 后强制 abort。
      const controller = new AbortController()
      const forwardAbort = (): void => controller.abort()
      if (context.abortSignal?.aborted === true) {
        controller.abort()
      } else {
        context.abortSignal?.addEventListener('abort', forwardAbort)
      }
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? defaultTimeoutMs)

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          redirect: 'follow',
        })
        if (!response.ok) {
          throw new Error(
            `fetch_url received HTTP ${response.status} ${response.statusText} for ${url}`
          )
        }
        const html = await response.text()
        const markdown = turndown.turndown(html).slice(0, maxMarkdownLength)
        return {
          url: response.url,
          markdown,
          statusCode: response.status,
          contentLength: markdown.length,
        }
      } finally {
        clearTimeout(timer)
        context.abortSignal?.removeEventListener('abort', forwardAbort)
      }
    },
  }
}
