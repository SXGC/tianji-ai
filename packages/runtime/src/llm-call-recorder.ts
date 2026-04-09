import type { AIMessage, BaseMessage } from '@langchain/core/messages'
import type { ToolMessage } from '@langchain/core/messages'
import { createMiddleware } from 'langchain'
import type { AgentMiddleware } from 'langchain'
import type {
  LlmCallRecord,
  LlmCallRequest,
  LlmCallResponse,
  LlmRawRecord,
  SerializedMessage,
  SerializedTool,
  SerializedToolCall,
} from './llm-raw-store.js'

/**
 * 在 middleware 的 wrapModelCall 中收集每次 LLM 调用。
 *
 * 用法：runTurn 开始时创建 → wrapModelCall 中调用 recordCall → runTurn 结束后 toRecord。
 */
export class LlmCallRecorder {
  private readonly calls: LlmCallRecord[] = []

  /**
   * 记录一次 LLM 调用，包含完整的 request 和 response。
   *
   * @param request - 调用 LLM 时的请求对象（ModelRequest 或兼容结构）
   * @param response - LLM 返回的 AIMessage
   */
  recordCall(request: Record<string, unknown>, response: AIMessage): void {
    this.calls.push({
      index: this.calls.length,
      request: serializeRequest(request),
      response: serializeResponse(response),
    })
  }

  /** 返回已记录的所有调用（只读）。 */
  getCalls(): readonly LlmCallRecord[] {
    return this.calls
  }

  /**
   * 将所有记录打包成 LlmRawRecord，用于传给 LlmRawStore 持久化。
   *
   * @param runId - 本次执行的唯一 ID
   * @param sessionId - 所属会话 ID
   */
  toRecord(runId: string, sessionId: string): LlmRawRecord {
    return {
      runId,
      sessionId,
      createdAt: Date.now(),
      calls: [...this.calls],
    }
  }
}

/**
 * 创建录制 LLM API 调用的 middleware。
 * 通过 wrapModelCall hook 拦截每次模型调用的完整 request/response。
 *
 * @param recorder - 用于存储调用记录的 LlmCallRecorder 实例
 */
export function createRecordingMiddleware(recorder: LlmCallRecorder): AgentMiddleware {
  return createMiddleware({
    name: 'tianji-llm-call-recorder',
    wrapModelCall: async (request, handler) => {
      const response = await handler(request)
      recorder.recordCall(request as unknown as Record<string, unknown>, response as AIMessage)
      return response
    },
  })
}

function serializeRequest(request: Record<string, unknown>): LlmCallRequest {
  return {
    model: extractModelName(request.model),
    systemPrompt: typeof request.systemPrompt === 'string' ? request.systemPrompt : '',
    messages: serializeMessages(request.messages),
    tools: serializeTools(request.tools),
    toolChoice: request.toolChoice,
    modelSettings:
      typeof request.modelSettings === 'object' && request.modelSettings !== null
        ? (request.modelSettings as Record<string, unknown>)
        : undefined,
  }
}

function serializeMessages(messages: unknown): SerializedMessage[] {
  if (!Array.isArray(messages)) return []

  return messages.map((msg: BaseMessage) => ({
    role: msg._getType(),
    content: msg.content,
    name: msg.name ?? undefined,
    toolCallId: isToolMessage(msg) ? msg.tool_call_id : undefined,
    additional_kwargs:
      Object.keys(msg.additional_kwargs ?? {}).length > 0
        ? (msg.additional_kwargs as Record<string, unknown>)
        : undefined,
  }))
}

/** ToolMessage 类型判断：通过 _getType() 鉴别。 */
function isToolMessage(msg: BaseMessage): msg is ToolMessage {
  return msg._getType() === 'tool'
}

function serializeTools(tools: unknown): SerializedTool[] {
  if (!Array.isArray(tools)) return []

  return tools.map((tool: unknown) => {
    if (typeof tool === 'object' && tool !== null) {
      const obj = tool as Record<string, unknown>
      return {
        name: typeof obj.name === 'string' ? obj.name : String(tool),
        description: typeof obj.description === 'string' ? obj.description : undefined,
        schema: obj.schema,
      }
    }
    return { name: String(tool) }
  })
}

function serializeResponse(response: AIMessage): LlmCallResponse {
  const toolCalls: SerializedToolCall[] = (response.tool_calls ?? []).map(
    (tc: { id?: string; name?: string; args?: unknown }) => ({
      id: tc.id ?? '',
      name: tc.name ?? '',
      args: tc.args,
    })
  )

  const usage = response.usage_metadata as
    | { input_tokens?: number; output_tokens?: number; total_tokens?: number }
    | undefined

  return {
    content: response.content,
    toolCalls,
    usageMetadata:
      usage !== undefined
        ? {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            totalTokens: usage.total_tokens,
          }
        : undefined,
    additional_kwargs:
      Object.keys(response.additional_kwargs ?? {}).length > 0
        ? (response.additional_kwargs as Record<string, unknown>)
        : undefined,
  }
}

/** 从 model 字段提取模型名称字符串。支持字符串直接值或对象中的 modelName/model/name 字段。 */
function extractModelName(model: unknown): string {
  if (model === undefined || model === null) return ''
  if (typeof model === 'string') return model
  if (typeof model === 'object') {
    const obj = model as Record<string, unknown>
    if (typeof obj.modelName === 'string') return obj.modelName
    if (typeof obj.model === 'string') return obj.model
    if (typeof obj.name === 'string') return obj.name
  }
  return ''
}
