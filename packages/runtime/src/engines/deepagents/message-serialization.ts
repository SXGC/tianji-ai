/**
 * deepagents 消息序列化层。
 *
 * 负责 AppMessage 与 deepagents message 格式的互转，包括：
 * - 将 AppMessage 压平为 deepagents 所需的 role + string content 格式。
 * - 从 deepagents 输出及流式 chunk 中构建 assistant 消息。
 * - 解析各类 chunk 字段（text、thinking、tool_calls、kwargs 等）。
 */
import { randomUUID } from 'node:crypto'

import type { AppMessage, MessageRole } from '@tianji/shared'

import { isRecord, stableSerialize } from './helpers.js'
import type { DeepagentsPendingToolCall } from './types.js'

/**
 * 将 AppMessage 压平为 deepagents 只接受的 role + string content 结构。
 */
export function convertAppMessageToDeepagentsMessage(message: AppMessage): {
  readonly role: MessageRole
  readonly content: string
} {
  return {
    role: message.role,
    content: message.content.map(serializeDeepagentsMessagePart).join('\n'),
  }
}

/**
 * 序列化单个消息片段，尽量保留文本语义，并为图片/工具调用生成可读占位文本。
 */
export function serializeDeepagentsMessagePart(part: AppMessage['content'][number]): string {
  if (part.type === 'text') {
    return part.text
  }

  if (part.type === 'thinking') {
    return part.thinking
  }

  if (part.type === 'image') {
    const source = part.url.startsWith('data:') ? '[embedded image omitted]' : part.url
    const mimeType = part.mimeType ?? readDataUriMimeType(part.url) ?? 'unknown'

    return `[image mimeType=${mimeType} source=${source}]`
  }

  if (part.type === 'tool-call') {
    return `[tool-call id=${part.toolCallId} name=${part.toolName} args=${stableSerialize(part.args)}]`
  }

  if (part.type === 'tool-result') {
    const resultPreview =
      typeof part.result === 'string'
        ? part.result.slice(0, 200)
        : stableSerialize(part.result).slice(0, 200)
    return `[tool-result id=${part.toolCallId} name=${part.toolName} error=${part.isError ?? false} result=${resultPreview}]`
  }

  const exhaustiveCheck: never = part
  throw new Error(`Unsupported message part type: ${exhaustiveCheck}`)
}

/**
 * 从 data URI 中提取 mime type；不是 data URI 或格式非法时返回 undefined。
 */
export function readDataUriMimeType(url: string): string | undefined {
  if (!url.startsWith('data:')) {
    return undefined
  }

  const separatorIndex = url.indexOf(',')

  if (separatorIndex < 0) {
    return undefined
  }

  const metadata = url.slice('data:'.length, separatorIndex)
  const mimeType = metadata.split(';', 1)[0]
  return mimeType.length > 0 ? mimeType : undefined
}

/**
 * 从 deepagents 最终输出中提取最后一条 assistant 文本；若提取失败则回退到流式聚合文本。
 */
export function buildAssistantMessageFromDeepagentsOutput(
  messageId: string,
  createdAt: number,
  aggregatedText: string,
  output: unknown
): AppMessage {
  const outputRecord = isRecord(output) ? output : undefined
  const messages = Array.isArray(outputRecord?.messages) ? outputRecord.messages : []
  const lastMessage = messages.at(-1)
  const extractedText = readFinalOutputText(lastMessage)

  return buildAssistantMessage(messageId, createdAt, extractedText ?? aggregatedText)
}

/**
 * 构造标准 assistant 消息对象，并在空文本时保持 content 为空数组。
 */
export function buildAssistantMessage(
  messageId: string,
  createdAt: number,
  content: string
): AppMessage {
  return {
    id: messageId,
    role: 'assistant',
    content: content.length === 0 ? [] : [{ type: 'text', text: content }],
    createdAt,
  }
}

/**
 * 读取单个模型流式 chunk 中的文本增量。
 */
export function readChunkText(chunk: unknown): string {
  if (isRecord(chunk) && typeof chunk.content === 'string') {
    return chunk.content
  }

  const kwargs = readChunkKwargs(chunk)
  return typeof kwargs?.content === 'string' ? kwargs.content : ''
}

/**
 * 从 chunk 中提取 content 数组（兼容直接属性和 kwargs 嵌套两种结构）。
 */
export function readContentBlocks(chunk: unknown): Array<Record<string, unknown>> {
  if (!isRecord(chunk)) return []
  if (Array.isArray(chunk.content)) return chunk.content.filter(isRecord)
  const kwargs = readChunkKwargs(chunk)
  if (kwargs !== undefined && Array.isArray(kwargs.content)) return kwargs.content.filter(isRecord)
  return []
}

/**
 * 读取单个模型流式 chunk 中的 thinking 增量。
 *
 * 兼容多种模型提供者的 thinking 字段路径：
 * - Anthropic (Claude): content 数组中 type 为 'thinking' 的 block
 * - OpenAI (o-series) / DeepSeek: additional_kwargs.reasoning_content
 */
export function readChunkThinking(chunk: unknown): string {
  const contentBlocks = readContentBlocks(chunk)
  for (const block of contentBlocks) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      return block.thinking
    }
  }

  const kwargs = readChunkKwargs(chunk)
  const additionalKwargs =
    kwargs !== undefined && isRecord(kwargs.additional_kwargs)
      ? kwargs.additional_kwargs
      : undefined
  if (additionalKwargs !== undefined && typeof additionalKwargs.reasoning_content === 'string') {
    return additionalKwargs.reasoning_content
  }

  return ''
}

/**
 * 读取 chunk 中按片段返回的 tool_call_chunks。
 */
export function readToolCallChunks(chunk: unknown): Array<Record<string, unknown>> {
  if (isRecord(chunk) && Array.isArray(chunk.tool_call_chunks)) {
    return chunk.tool_call_chunks.filter(isRecord)
  }

  const kwargs = readChunkKwargs(chunk)
  const toolCallChunks = kwargs?.tool_call_chunks

  if (!Array.isArray(toolCallChunks)) {
    return []
  }

  return toolCallChunks.filter(isRecord)
}

/**
 * 读取 chunk 中已聚合完成的 tool_calls。
 */
export function readToolCalls(chunk: unknown): Array<Record<string, unknown>> {
  if (isRecord(chunk) && Array.isArray(chunk.tool_calls)) {
    return chunk.tool_calls.filter(isRecord)
  }

  const kwargs = readChunkKwargs(chunk)
  const toolCalls = kwargs?.tool_calls

  if (!Array.isArray(toolCalls)) {
    return []
  }

  return toolCalls.filter(isRecord)
}

/**
 * 从 chunk 中提取 runtime 可跟踪的工具调用观测记录，兼容增量片段和完整调用两种格式。
 */
export function readObservedToolCalls(chunk: unknown): DeepagentsPendingToolCall[] {
  const chunkCalls = readToolCallChunks(chunk).map((toolCallChunk) => ({
    toolCallId:
      typeof toolCallChunk.id === 'string' && toolCallChunk.id.length > 0
        ? toolCallChunk.id
        : `tool_${randomUUID()}`,
    toolName: typeof toolCallChunk.name === 'string' ? toolCallChunk.name : 'unknown_tool',
    argsText: typeof toolCallChunk.args === 'string' ? toolCallChunk.args : '',
    args: parseToolArgs(typeof toolCallChunk.args === 'string' ? toolCallChunk.args : ''),
    consumed: false,
  }))

  if (chunkCalls.length > 0) {
    return chunkCalls
  }

  return readToolCalls(chunk).map((toolCall) => {
    const args = 'args' in toolCall ? toolCall.args : undefined
    const argsText = stableSerialize(args)

    return {
      toolCallId:
        typeof toolCall.id === 'string' && toolCall.id.length > 0
          ? toolCall.id
          : `tool_${randomUUID()}`,
      toolName: typeof toolCall.name === 'string' ? toolCall.name : 'unknown_tool',
      argsText,
      args,
      consumed: false,
    }
  })
}

/**
 * 读取 chunk.kwargs，并确保其为对象结构。
 */
export function readChunkKwargs(chunk: unknown): Record<string, unknown> | undefined {
  if (!isRecord(chunk)) {
    return undefined
  }

  return isRecord(chunk.kwargs) ? chunk.kwargs : undefined
}

/**
 * 提取 deepagents 最终消息中的文本内容。
 */
export function readFinalOutputText(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined
  }

  if (typeof message.content === 'string') {
    return message.content
  }

  const kwargs = isRecord(message.kwargs) ? message.kwargs : undefined
  return typeof kwargs?.content === 'string' ? kwargs.content : undefined
}

/**
 * 解析工具参数字符串；无法解析为 JSON 时保留原始字符串。
 */
export function parseToolArgs(value: string): unknown {
  if (value.length === 0) {
    return undefined
  }

  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
